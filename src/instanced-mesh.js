AFRAME.registerComponent('instanced-mesh', {
  schema: {
      capacity:   {type: 'number', default: 100},
      fcradius:   {type: 'number', default: 0},
      fccenter:   {type: 'vec3'},
      positioning: {type: 'string', default: "local"},
      debug:      {type: 'boolean', default: false},
      layers:     {type: 'string', default: ""},
      updateMode: {type: 'string', default: "manual", oneOf: ["auto", "manual"]},
      decompose:  {type: 'boolean', default: true}
  },

  init: function () {
    this.capacity = this.data.capacity;
    this.members = 0;
    this.debug = this.data.debug;
    this.meshLoaded = false;
    this.texturesLoaded = 0;
    this.eventQueue = [];

    // Bounding sphere used for frustrum culling
    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0);

    // Other objects used in frame of reference calculations.
    // Only used for working - these don't contain any persistent meaingful data.
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3();

    // List of members flagged for removal.  Used to efficiently delete
    // multiple entries.
    this.membersToRemove = [];

    // Ordered list of member entity IDs.  This matches order in the Instanced
    // Mesh matrix list.  Needed so that we can delete elements on request.
    // I have not thought very deeply about performance of an array vs. e.g. an
    // object used as a dictionary.
    // We have 2 requirements in tension:
    // A - for modifications, we want a fast lookup using the entity ID.
    // B - for removals, we want to be able to remove an item and efficiently
    //   update all the later indices, as we renumber to fill in the gap.
    //
    // While I have not tested comparative performance, we can easily meet A and
    // B using an Array using findIndex (A) and splice (B).
    // A dictionary-style object would be great for A, but harder for B, I suspect.

    this.orderedMembersList = [];

    this.listeners = {
      memberAdded: this.memberAdded.bind(this),
      memberModified: this.memberModified.bind(this),
      memberRemoved: this.memberRemoved.bind(this),
    };
    this.attachEventListeners();

    // Used for working, to save re-allocations.
    this.matrix = new THREE.Matrix4();
    this.inverseMatrix = new THREE.Matrix4();
    this.debugMatrix = new THREE.Matrix4();
    this.componentMatrix = new THREE.Matrix4();

    // stored inverse of the parent's matrixWorld (to save re-calculations)
    // code that uses this should intelligently update it when necessary.
    this.parentWorldMatrixInverse = this.el.object3D.parent.matrixWorld.clone()
    this.parentWorldMatrixInverse.invert()

    // Used when setting color attributes in instanced meshes.
    this.color = new THREE.Color()
  },

  attachEventListeners: function() {
    this.el.addEventListener('memberAdded', this.listeners.memberAdded, false);
    this.el.addEventListener('memberModified', this.listeners.memberModified, false);
    this.el.addEventListener('memberRemoved', this.listeners.memberRemoved, false);
  },

  update: function () {

    // set configured positioning mode
    switch (this.data.positioning) {
      case "local":
        this.localPositioning = true;
        break;

      case "world":
        this.localPositioning = false;
        break;

      default:
        console.log(`Unexpected value for 'positioning' attribute: ${this.data.positioning}`);
        console.log(`Defaulting to "local" positioning`);
        this.localPositioning = true;
        break;
    }

    // store off whether we are in auto mode, for fast checking.
    this.autoMode = (this.data.updateMode === "auto")

    // Possible we are waiting for a GLTF model to load.  If so, defer processing...
    // !! We have a bug where using a geometry where that is specified on the
    // object *after* instanced-mesh.  This component gets initialized first but there
    // is no "model-loaded" event.  What's the equivalent?
    // For now, solution is to always specify instanced-mesh *after* geometry.
    var previousMesh = this.el.getObject3D('mesh')
    if (!previousMesh) {
        this.el.addEventListener('model-loaded', e => {
          this.update.call(this, this.data)
        })
        return;
    }

    // If there are textures to be loaded, wait for them all to load before
    // proceeding.
    if (this.el.components.material &&
        this.el.components.material.shader &&
        this.el.components.material.shader.materialSrcs) {

      this.countTexturesToLoad();

      if (this.texturesToLoad !== this.texturesLoaded) {

        // still textures to load.
        this.el.addEventListener("materialtextureloaded", (e) => {
          this.texturesLoaded++;
          if (this.texturesToLoad === this.texturesLoaded) {
            // All textures loaded - proceed.
            this.update.call(this, this.data)
          }
        })
        return;
      }
    }

    if (previousMesh.count > 0) {
      // we already have a set of instanced meshes in place.
      console.assert(previousMesh === this.instancedMeshes[0])

      // but do they have enough capacity?
      if (previousMesh.instanceMatrix.count < this.data.capacity) {
        // resize instanced meshes
        this.increaseInstancedMeshCapacity();
      }
      else {
        // We can continue using existing instanced meshes.
      }
    }
    else {
      // No instanced Meshes yet in place.  Analyze original mesh to see how to
      // build the instanced Meshes.
      

      this.meshNodes = this.constructMeshNodes(previousMesh);

      this.instancedMeshes = [];
      this.componentMatrices = [];
      this.componentMaterials = [];

      this.meshNodes.forEach((node, index) => {
        var instancedMesh = new THREE.InstancedMesh(node.geometry,
                                                    node.material,
                                                    this.data.capacity);

        // For each instanced mesh required, we store off both the instanced mesh
        // itself. and the transform matrix for the component of the model that
        // it represents.
        this.instancedMeshes.push(instancedMesh)
        this.componentMatrices.push(node.matrixWorld)
        this.componentMaterials.push(node.materialIndex)
      });

      // Add all the instanced meshes as children of the object3D, and hide
      // the original mesh.
      this.instancedMeshes.forEach(mesh => {
        this.el.object3D.add(mesh);
      });
      
      // Keep the original mesh, but make invisible.
      // Useful for generating per-member meshes for physics/raycasting.
      // (see instanced-mesh-member 'memberMesh' option)
      this.originalMesh = previousMesh;
      this.el.emit("original-mesh-ready")
      previousMesh.visible = false;

      // set the Object3D Map to point to the first instanced mesh.
      this.el.setObject3D('mesh', this.instancedMeshes[0]);
    }

    // some other details that may need to be updated on the instanced meshes...
    this.updateFrustrumCulling();
    this.updateLayers();

    // set the Object3D Map to point to the first instanced mesh.
    this.el.setObject3D('mesh', this.instancedMeshes[0]);

    this.meshLoaded = true;

    // process any events pending on this mesh.
    this.processQueuedEvents();
  },

  countTexturesToLoad: function () {

    const material = this.el.components.material
    const shader = material.shader
    const textures = shader.materialSrcs

    // start with materialSrcs
    this.texturesToLoad = Object.keys(shader.materialSrcs).length;

    // add in other shader textures that may be needed.
    this.texturesToLoad += shader.ambientOcclusionTextureSrc ? 1 : 0;
    this.texturesToLoad += shader.displacementTextureSrc ? 1 : 0;
    this.texturesToLoad += shader.normalTextureSrc ? 1 : 0;
    this.texturesToLoad += (shader.isLoadingEnvMap ||
                            material.material.envMap) ? 1 : 0;
  },

  increaseInstancedMeshCapacity: function() {

    newMeshes = [];

    this.meshNodes.forEach((node, index) => {
      const oldMesh = this.instancedMeshes[index];
      var newMesh = new THREE.InstancedMesh(node.geometry,
                                            node.material,
                                            this.data.capacity);
      newMeshes.push(newMesh);
      for (ii = 0; ii < Math.min(oldMesh.count, this.data.capacity); ii ++ ) {
        oldMesh.getMatrixAt(ii, this.matrix)
        newMesh.setMatrixAt(ii, this.matrix);
      }

      this.el.object3D.add(newMesh);
      this.el.object3D.remove(oldMesh);

      // THREE.js docs say we should also all this when finished with an Instanced Mesh.
      // but doing so is causing an error.
      // So maybe we have a small leak as a result of not doing this, but I don't know how to fix...
      // oldMesh.dispose();
    });

    this.instancedMeshes = newMeshes;
    this.el.setObject3D('mesh', this.instancedMeshes[0]);
  },

  updateFrustrumCulling: function() {

    // Set up frustrum culling if configured.
    // This uses a separate "boundingSphere" object that represents the
    // maximum extent of all members of the mesh.
    // If one is specified, we us this for frustrum culling.  If not, we don't
    // use frustrum culling at all for this mesh.
    if (this.data.fcradius > 0) {
      this.boundingSphere.center.copy(this.data.fccenter);
      this.boundingSphere.radius = this.data.fcradius;
      this.instancedMeshes.forEach(mesh => {
        mesh.geometry.boundingSphere = this.boundingSphere;
        mesh.frustumCulled = true;
      });
    }
    else
    {
      this.instancedMeshes.forEach(mesh => {
        mesh.frustumCulled = false;
      });
    }
  },

  updateLayers: function() {

    if (this.data.layers !== "") {
      const layerNumbers = this.data.layers.split(",").map(Number);
      // Reset
      this.instancedMeshes.forEach(mesh => {
        mesh.layers.disableAll();
      });

      // Apply
      for (let num of layerNumbers) {
        this.instancedMeshes.forEach(mesh => {
          mesh.layers.enable(num);
        });
      }
    }
  },

  // This constructs our inetrnal view of the properties of the original Mesh
  // that we need to capture for instancing, namely:
  // - geometry of each component
  // - material(s) of each component
  // - transforms of each component.
  constructMeshNodes: function(originalMesh) {
    meshNodes  = [];

    originalMesh.updateMatrixWorld()
    this.inverseMatrix.copy(originalMesh.matrixWorld)
    this.inverseMatrix.invert()
    const inverseMatrix = this.inverseMatrix

    originalMesh.traverse((node) => {

      let material;
      let geometry;

      if(node.type != "Mesh") return;
      geometry = node.geometry;

      if (this.data.decompose && geometry.groups && geometry.groups.length > 1) {
        // geometry consists of multiple groups, to decompose.

        const materialIndices = new Set()
        geometry.groups.forEach((group) => {
          materialIndices.add(group.materialIndex)
        })

        materialIndices.forEach((index) => {
          const partGeometries = this.constructPartGeometries(geometry, index);

          partGeometries.forEach((partGeometry) => {

            // Use specified material; or default if none specified for this index.
            if (Array.isArray(node.material)) {
              if (node.material.length > index) {
                material = node.material[index].clone();
              }
              else {
                material = node.material[0].clone();
              }
            }
            else
            {
              material = node.material.clone();
            }

            // Set material color to white.  Colors set on instanced Mesh are combined with this
            // color, so setting to white gives access to full range of color values.
            material.color.set("white")

            node.updateMatrixWorld();
            const matrix = node.matrixWorld.clone();
            matrix.premultiply(inverseMatrix);
                
            meshNodes.push({'geometry' : partGeometry,
                            'material' : material,
                            'materialIndex' : index,
                            'matrixWorld': matrix});
          })
        })
      }
      else {
        // material can be an array of materials.  We want the whole array.
        // Why clone?  AFrame-InstancedMesh says:
        // this component creates a .clone() of parent material because of a known
        // threejs limitation.
        // I don't yet have a reference for what that threejs limittation is, and
        // whether it still applies.
        material = this.cloneMaterial(node.material)

        node.updateMatrixWorld();
        const matrix = node.matrixWorld.clone();
        matrix.premultiply(inverseMatrix);

        meshNodes.push({'geometry' : geometry,
                        'material' : material,
                        'materialIndex' : 0,
                        'matrixWorld': matrix});
      }
    });

    return meshNodes;
  },

  cloneMaterial(material) {

    if (Array.isArray(material)) {
      material = [];
      material.forEach(item => material.push(item.clone()));
    }
    else
    {
      material = material.clone();
    }

    // Set material color to white.  Colors set on instanced Mesh are combined with this
    // color, so setting to white gives access to full range of color values.
    material.color.set("white")

    return material;
  },

  constructPartGeometries(geometry, materialIndex) {
    // construct an array of partial geometries that will render the
    // parts of a geometry that match a given materialIndex.
    const partGeometries = []

    geometry.groups.forEach((group) => {
      if (group.materialIndex === materialIndex) {
        const partGeometry = geometry.clone()
        partGeometry.setDrawRange(group.start, group.count)
        partGeometries.push(partGeometry)
        partGeometry.clearGroups()
      }
    })

    return partGeometries;
  },

  memberAdded: function(event) {

    if (!this.meshLoaded) {
      // Mesh not yet loaded, so instanced mesh not yet created.
      // Queue this event up for later processing.
      this.queueEvent(event)
      return;
    }

    if (this.debug) {
      console.log(`Member ${event.detail.member.id} to be added`);
    }

    const member = event.detail.member;
    var index;

    // First, choose the index for the new member.
    // 2 possibilities...
    // 1. If there are members pending deletion, just overwrite one of them.
    if (this.membersToRemove.length > 0) {

      // Grab the index, and remove this index from the list of pending deletions.
      const memberToRemove = this.membersToRemove[0];
      index = this.orderedMembersList.findIndex(x => (x == memberToRemove));

      this.membersToRemove.splice(0, 1);
      this.orderedMembersList[index] = member;
    }
    // 2. If nothing is pending deletion, so just add to the end of the list as
    //    a new member.
    else
    {
      if (this.members > this.capacity) {
        // Don't go over capacity.
        console.warn(`Member not added to mesh ${this.el.id}.  Exceeded configured capacity of ${this.capacity}`)
        console.warn(`To fix, set 'capacity' property on instanced-mesh attribute on entity:${this.el.id} (default is 100)`)
        return;
      }

      index = this.members;
      this.members++;
      this.orderedMembersList.push(member);
    }

    this.updateMatricesFromMemberObject(member.object3D, index, this.autoMode);

    // Diags: Dump full matrix of x/y positions:
    //for (var jj = 0; jj < this.members; jj++) {
      //console.log(`x: ${this.instancedMesh.instanceMatrix.array[jj * 16 + 12]}, y: ${this.instancedMesh.instanceMatrix.array[jj * 16 + 13]}`);
    //}

    this.instancedMeshes.forEach(mesh => {
      mesh.count = this.members;
      mesh.instanceMatrix.needsUpdate = true;
    });
  },

  // For a given index position, across all instanced meshes, update the
  // matrices to match the transform of the member object
  // (provided in the object3D)
  updateMatricesFromMemberObject(object3D, index, auto) {

    let matrix
    if (auto) {
      matrix = this.matrixFromMemberObjectAuto(object3D);
    }
    else {
      matrix = this.matrixFromMemberObjectManual(object3D);
    }

    // don't output console logs for matrix updates in auto mode - too verbose.
    const debug = (this.debug && !this.autoMode)
    const componentMatrix = this.componentMatrix;
    this.instancedMeshes.forEach((mesh, componentIndex) => {

      if (debug) {
        //console.log(`Modifying member ${id} at position ${index}`);
        console.log(`Setting matrix for component index ${componentIndex}`)

        mesh.getMatrixAt(index, this.debugMatrix);

        var position = this.position;
        position.setFromMatrixPosition(this.debugMatrix);
        console.log(`Old position:${position.x} ${position.y} ${position.z}`);
        position.setFromMatrixPosition(object3D.matrix);
        console.log(`New position:${position.x} ${position.y} ${position.z}`);
      }

      componentMatrix.multiplyMatrices(matrix, this.componentMatrices[componentIndex]);
      mesh.setMatrixAt(index, componentMatrix);

      let color
      const colorIndex = this.componentMaterials[componentIndex]
      let colors = object3D.el.components['instanced-mesh-member'].data.colors
      if (colors.length > 0) {
        
        if (colorIndex) {
          this.color.set(colors[colorIndex])
        }
        else if (Array.isArray(colors)) {
          this.color.set(colors[0])
        }
        else {
          this.color.set(colors)
        }
      }
      else {
        if (Array.isArray(this.originalMesh.material)) {
          this.color.copy(this.originalMesh.material[colorIndex].color)
        }
        else {
          this.color.copy(this.originalMesh.material.color)
        }
      }
      mesh.setColorAt(index, this.color)

      mesh.instanceMatrix.needsUpdate = true;
    });
  },

  // Get the matrix to add to an instanced mesh from an object 3D
  // allowing for positioning style (local or world)
  // This version used for Manual updates - it ensures data is up-to-date
  // for computations.
  matrixFromMemberObjectManual: function(object3D) {

    if (this.localPositioning) {

      object3D.updateMatrix()
      return object3D.matrix;
    }
    else
    {
      const parent = this.el.object3D.parent
      const parentInverse = this.parentWorldMatrixInverse
      // Don't understand why this is necessaty.
      // parent.updateWorldMatrix() which updates the parent's worlDMatrix ought to be sufficient
      // But only parent.updateMatrixWorld() seems to get everything into the right state.
      // Even parent.updateWorldMatrix(true, true), which seems more-or-less equivalent doesn't work.
      // Some careful testing needed to figure this out & find the optimal solution.
      // Issue being that parent.updateWorldMatrix() is quite performance-intensive.
      parent.updateMatrixWorld()
      parentInverse.copy(parent.matrixWorld)
      parentInverse.invert()
      
      // matrix used for working...
      const matrix = this.matrix
      matrix.multiplyMatrices(parentInverse, object3D.matrixWorld) 
      return matrix;
    }
  },

  // Get the matrix to add to an instanced mesh from an object 3D
  // allowing for positioning style (local or world)
  // This version used for Auto updates - it does not ensures data is up-to-date
  // for computations, based on the fact that the data will be updated again the 
  // in the next frame.
  matrixFromMemberObjectAuto: function(object3D) {

    if (this.localPositioning) {
      return object3D.matrix;
    }
    else
    {
      const matrix = this.matrix;
      matrix.multiplyMatrices(this.parentWorldMatrixInverse, object3D.matrixWorld) 
      return matrix;
    }
  },

  memberModified: function(event) {

    if (!this.meshLoaded) {
      // Mesh not yet loaded, so instanced mesh not yet created.
      // Queue this event up for later processing.
      this.queueEvent(event)
      return;
    }

    // Not yet thought about transitations between frames of reference
    // Just assume all in same FOR for now..
    const member = event.detail.member;
    const index = this.orderedMembersList.findIndex(x => (x === member));

    if (index == -1) {
      console.error(`Member ${id} not found for modification`)
    }

    this.updateMatricesFromMemberObject(event.detail.member.object3D, index, this.autoMode);
  },

  memberRemoved: function(event) {
    if (this.debug) {
      console.log(`Member ${event.detail.member.id} to be removed`);
    }

    if (!this.meshLoaded) {
      // Mesh not yet loaded, so instanced mesh not yet created.
      // Queue this event up for later processing.
      this.queueEvent(event)
      return;
    }

    // If multiple members are removed at once, it's inefficient to process
    // them individually.

    // So we just mark a member as needing removal, and do the actual clean-up
    // at the next tick, by which time we may have collected a number of
    // deletions to handle all together.
    //console.log("Removing mesh member with ID:" + event.detail.member.id);
    this.membersToRemove.push(event.detail.member);
    if (this.debug) {
      console.log(`Member ${event.detail.member.id} queued up for removal`);
    }
  },

  queueEvent: function (event) {
    this.eventQueue.push(event);
  },

  processQueuedEvents: function () {
    this.eventQueue.forEach((item) => {
      switch (item.type) {

        case "memberAdded":
          this.memberAdded(item);
          break;

        case "memberModified":
          this.memberModified(item);
          break;

        case "memberRemoved":
          this.memberRemoved(item);
          break;

        default:
          console.log(`Unexpected Event Type: ${item.type}`);
          break;
      }

      // Processed all queued events, so clear the queue.
      this.eventQueue = [];
    });
  },

  tick: function (time, timeDelta) {
    
    if (this.membersToRemove.length > 0) {
      // We have members to Remove.
      // We need to iterate through all members, as those that aren't removed
      // still need to be shuffled up.
      var removed = 0;


      for (var ii = 0; ii < this.members; ii++) {
        // Check whether this one is to be removed (taking into account
        // index shuffling that has already taken place...)
        // If so, increment the amount we are shuffling up by, which will
        // lead to this entry being overwritten.

        var matrixCursor = ii;
        var membersCursor = ii - removed;

        if (this.membersToRemove.includes(this.orderedMembersList[membersCursor])) {
          //console.log(`Item to remove: ${this.orderedMembersList[membersCursor]} at position ${matrixCursor}`)
          if (this.debug) {
            console.log(`Removing member ${this.orderedMembersList[membersCursor]} at position ${membersCursor}`);
          }
          this.orderedMembersList.splice(membersCursor, 1);
          removed++;
        }
        // Now do the shuffle up.
        // If we just incremented the count of removed elements, the current
        // element will get overwritten.
        // Else items will just get shuffled up.
        if (removed > 0) {
          //console.log(`copying cell from ${matrixCursor + 1} to ${matrixCursor - removed + 1}`);

          if (matrixCursor + 1 < this.members) {

            this.instancedMeshes.forEach(mesh => {

              mesh.getMatrixAt(matrixCursor + 1, this.matrix);
              mesh.setMatrixAt(matrixCursor - removed + 1, this.matrix);
            });
          }
        }
      }
      this.members -= removed;

      this.instancedMeshes.forEach(mesh => {
        mesh.count = this.members;
        mesh.instanceMatrix.needsUpdate = true;
      });

      // No further pending removals.
      this.membersToRemove = [];

      // Diags: Dump full matrix of x/y positions:
      //for (var jj = 0; jj < this.members; jj++) {
        //console.log(`x: ${this.instancedMesh.instanceMatrix.array[jj * 16 + 12]}, y: ${this.instancedMesh.instanceMatrix.array[jj * 16 + 13]}`);
      //}

      console.log("Removals done");
    }

    if (this.autoMode) {

      // update this.parentWorldMatrixInverse, which will be used in matrix calculations.
      const parent = this.el.object3D.parent
      const parentInverse = this.parentWorldMatrixInverse
      parent.updateWorldMatrix();
      parentInverse.copy(parent.matrixWorld)
      parentInverse.invert()

      const list = this.orderedMembersList
      const members = this.members
      for (let ii = 0; ii < members; ii++) {
        const object = list[ii].object3D
        
        if (object) {
          this.updateMatricesFromMemberObject(object, ii, true);
        }
      }; 
    }
  }
});

AFRAME.registerComponent('instanced-mesh-member', {
  schema: {
        mesh:       {type: 'selector'},
        debug:      {type: 'boolean', default: false},
        memberMesh: {type: 'boolean', default: false},
        colors:     {type: 'array'}
  },

  init: function() {
    this.index = -1;
    this.added = false;
    this.debug = this.data.debug;
    this.listeners = {
      object3DUpdated: this.object3DUpdated.bind(this),
    };
    this.attachEventListeners();

    // Some state we track, to help make the right updates to the Instanced Mesh.
    this.visible = this.el.object3D.visible;
    this.matrix = this.el.object3D.matrix.clone();
  },

  update: function () {
    // look for changes to be mirrored to the Mesh.
    if (this.visible) {
      // Object was previously visible.  But might not be any more...
      if (!this.el.object3D.visible) {
        if (this.debug) {
          console.log("Removed (v):" + this.el.id);
        }
        this.data.mesh.emit('memberRemoved', {member: this.el});
        this.visible = false;
      }
      else {
        // Object was & is visible.  Check for other updates that need to be
        // mirrored to the Mesh.
        // Basically just the localMatrix at this stage...
        // (we'll need to revisit when we support multiple frames of reference...)
        if (!this.matrix.equals(this.el.object3D.matrix)) {
          // there's been some change to position, orientation or scale, so
          // mirror it.
          if (this.debug) {
            console.log("Modified:" + this.el.id);
          }
          this.data.mesh.emit('memberModified', {'member': this.el});
          this.matrix.copy(this.el.object3D.matrix);
        }
      }
    }
    else {
      // Object not previously visible.  But might have just become...
      if (this.el.object3D.visible) {
        if (this.debug) {
          console.log("Added (v):" + this.el.id);
        }
        this.data.mesh.emit('memberAdded', {member: this.el});
        this.matrix.copy(this.el.object3D.matrix);
        this.visible = true;
        this.added = true;
      }
    }

    // create/remove invisible member mesh from the instanced mesh if needed.
    if (this.data.memberMesh && !this.el.getObject3D('mesh'))
    {
      const originalMesh = this.data.mesh.components['instanced-mesh'].originalMesh
      const el = this.el

      function setMesh(mesh) {
        const newMesh = mesh.clone()
        newMesh.visible = false
        el.setObject3D('mesh', newMesh)
      }

      if (originalMesh) {
        setMesh(originalMesh)
      }
      else {
        this.data.mesh.addEventListener('original-mesh-ready', e => {
          setMesh(this.data.mesh.components['instanced-mesh'].originalMesh)
        });
      }
    }
    else if (!this.data.memberMesh && this.el.getObject3D('mesh')) {
      this.el.removeObject3D('mesh')
    }
  },

  play: function () {
    // We hold off adding the member to the mesh until this point
    // because prior to this (e.g. on init or update), the scale properties of
    // object3D don't seem to have been set to the correct values.
    if ((!this.added) &&
        (this.el.object3D.visible)) {
      if (this.debug) {
        //console.log(`Position: ${this.el.object3D.position.x} ${this.el.object3D.position.y}`)
        console.log("Added:" + this.el.id);
      }
      this.data.mesh.emit('memberAdded', {member: this.el});
      this.matrix.copy(this.el.object3D.matrix);
      this.added = true;
    }
  },

  attachEventListeners: function() {
    this.el.addEventListener('object3DUpdated', this.listeners.object3DUpdated, false);
  },

  remove: function() {
    if (this.debug) {
      console.log("Removed:" + this.el.id);
    }
    this.data.mesh.emit("memberRemoved", {'member': this.el});
  },

  // This should be invoked whenever the Object3D is updated.
  // Mirror any changes across to the parent instance mesh.
  // IMPORTANT: make sure matrix is up to date with any applied
  // changes, before making the updates to the Instanced Mesh.
  object3DUpdated: function(event) {
    if (this.debug) {
      console.log("Updated:" + this.el.id);
    }
    this.el.object3D.updateMatrix();
    this.update();
  }

});
