import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

// ===== 設定項目 =====
const WORLD_SCALE = 0.25;
const ARM_BODY_SCALE = 0.7; 
const CLAW_SCALE = 1.5; 
const ARM_SCALE = 2; 

// 操作時の移動速度
const ARM_MOVE_SPEED = 1.2; 
// ★戻るときの速度（ゆっくりにするため係数をかけます）
const RETURN_SPEED_RATIO = 0.4; 

const ARM_HOLD_SPEED_X = 0.6;
const ARM_HOLD_SPEED_Z = 0.6;

const ARM_MAX_X = 1.2;
const ARM_MIN_Z = -1.0;
const HOME_X = -1.2;
const HOME_Z = 0.6;

const CLAW_L_CLOSED = 0.4;
const CLAW_L_OPEN = -0.3;
const CLAW_R_CLOSED = -0.6;
const CLAW_R_OPEN = 0.2;

// ===== 爪ヒットボックス設定 =====
const HB_SCALE = 1.0;
const HB_Y = -0.22;
const HB_GAP1 = -0.16;
const HB_GAP2 = -0.07;
const HB_Z1 = 0.00;
const HB_Z2 = 0.12;
const HB_Z3 = 0.22;

const HB1 = { x: 0.10, y: 0.18, z: 0.08 };
const HB2 = { x: 0.10, y: 0.06, z: 0.14 };
const HB3 = { x: 0.08, y: 0.06, z: 0.10 };

const HB1_ROT = { x: 40, y: 0, z: 0 };
const HB2_ROT = { x: 0, y: 0, z: 0 };
const HB3_ROT = { x: 0, y: 0, z: 0 };

const HB_Z_SIGN_L = -1;
const HB_Z_SIGN_R = +1;

function quatFromEuler(x, y, z) {
  const q = new CANNON.Quaternion();
  q.setFromEuler(x, y, z, "XYZ");
  return q;
}

// ===== 自動シーケンス設定 =====
const CLAW_OPEN_TIME = 0.6;
const ARM_DROP_DIST = 1;
const ARM_DROP_SPEED = 0.6;
const CLAW_CLOSE_TIME = 0.6;

// ステップ: 0=待機, 1=開く, 2=下げる, 3=閉じる, 4=上げる, 5=戻る, 6=離す(開), 7=リセット(閉)
let autoStep = 0;
let autoT = 0;
let dropStartY = 0;
let autoStarted = false;

let holdMove = { x: 0, z: 0 };
let phase = 0; // 0:→のみ / 1:↑のみ / 2:完了後

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 2, 3.2);
camera.lookAt(0, 0.4, 0);

// ===== カメラ切替 =====
const camBtn = document.createElement("button");
camBtn.style.position = "fixed";
camBtn.style.right = "18px";
camBtn.style.bottom = "18px";
camBtn.style.width = "100px";
camBtn.style.height = "100px";
camBtn.style.border = "none";
camBtn.style.borderRadius = "12px";
camBtn.style.background = "rgba(255,255,255,0.85)";
camBtn.style.cursor = "pointer";
camBtn.style.zIndex = "9999";
const camImg = document.createElement("img");
camImg.src = "./assets/camera.png"; 
camImg.style.width = "70%";
camBtn.appendChild(camImg);
document.body.appendChild(camBtn);

const FRONT_POS = new THREE.Vector3(0, 2, 3.2);
const RIGHT_POS = new THREE.Vector3(3.2, 2, 0);
const LOOK_AT = new THREE.Vector3(0, 0.4, 0);

function setClawOpen01(open01) {
  const l = THREE.MathUtils.lerp(CLAW_L_CLOSED, CLAW_L_OPEN, open01);
  const r = THREE.MathUtils.lerp(CLAW_R_CLOSED, CLAW_R_OPEN, open01);
  if (clawLPivot) clawLPivot.rotation.x = l;
  if (clawRPivot) clawRPivot.rotation.x = r;
}

let camMode = 0;
function applyCamera() {
  if (camMode === 0) camera.position.copy(FRONT_POS);
  else camera.position.copy(RIGHT_POS);
  camera.lookAt(LOOK_AT);
}
applyCamera();

camBtn.addEventListener("click", () => {
  camMode = 1 - camMode;
  applyCamera();
});

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(2, 3, 2);
scene.add(dir);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ===== 物理設定 =====
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;

const matStick = new CANNON.Material("stick");
const matBox = new CANNON.Material("box");
const matClaw = new CANNON.Material("claw");

// 棒 vs 箱 (摩擦低め)
world.addContactMaterial(
  new CANNON.ContactMaterial(matStick, matBox, { friction: 0.05, restitution: 0.0 })
);
// 爪 vs 箱 (摩擦高め=しっかり掴む)
world.addContactMaterial(
  new CANNON.ContactMaterial(matClaw, matBox, {
    friction: 0.9,
    restitution: 0.0,
    contactEquationStiffness: 1e7,
    frictionEquationStiffness: 1e7
  })
);

const loader = new GLTFLoader();

// ===== 変数定義 =====
let boxMesh, stick1Mesh, stick2Mesh, craneMesh;
let stick3Mesh, stick4Mesh;
let boxBody, stick1Body, stick2Body, stick3Body, stick4Body;
let armMesh, clawLMesh, clawRMesh, armGroup;
let clawPivot, clawLPivot, clawRPivot;
let armBody, clawLBody, clawRBody;
let clawLVis = [], clawRVis = [];

// ===== ユーティリティ =====
function getBox3(obj3d) { return new THREE.Box3().setFromObject(obj3d); }
function getBoxSize(obj3d) {
  const size = new THREE.Vector3();
  getBox3(obj3d).getSize(size);
  return size;
}
function threeVecToCannon(v) { return new CANNON.Vec3(v.x, v.y, v.z); }
function threeQuatToCannon(q) { return new CANNON.Quaternion(q.x, q.y, q.z, q.w); }
function cannonVecToThree(v) { return new THREE.Vector3(v.x, v.y, v.z); }
function cannonQuatToThree(q) { return new THREE.Quaternion(q.x, q.y, q.z, q.w); }

// UIボタン
const arrowUI = document.createElement("div");
arrowUI.style.position = "fixed";
arrowUI.style.left = "50%";
arrowUI.style.top = "75%";
arrowUI.style.transform = "translate(-50%, -50%)";
arrowUI.style.display = "flex";
arrowUI.style.gap = "18px";
arrowUI.style.zIndex = "9999";
document.body.appendChild(arrowUI);

function makeArrowButton(rotationDeg = 0) {
  const btn = document.createElement("button");
  btn.style.width = "100px";
  btn.style.height = "100px";
  btn.style.border = "none";
  btn.style.background = "transparent";
  btn.style.display = "grid";
  btn.style.placeItems = "center";
  const img = document.createElement("img");
  img.src = "./assets/Arrow.png";
  img.style.transform = `rotate(${rotationDeg}deg)`;
  img.style.width = "100%";
  img.style.pointerEvents = "none";
  btn.appendChild(img);

  btn.setEnabled = (enabled) => {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.45";
    btn.style.filter = enabled ? "none" : "grayscale(1) brightness(0.7)";
    btn.style.pointerEvents = enabled ? "auto" : "none";
  };
  return btn;
}

const arrowBtn1 = makeArrowButton(0);
const arrowBtn2 = makeArrowButton(-90);
arrowUI.appendChild(arrowBtn1);
arrowUI.appendChild(arrowBtn2);
arrowBtn1.setEnabled(true);
arrowBtn2.setEnabled(false);

function bindHoldMove(btn, onStart, onEnd) {
  const stop = () => {
    holdMove.x = 0; holdMove.z = 0;
    btn.releasePointerCapture?.(btn._pid);
  };
  btn.addEventListener("pointerdown", (e) => {
    if (btn.disabled) return;
    btn._pid = e.pointerId;
    btn.setPointerCapture?.(e.pointerId);
    onStart();
  });
  btn.addEventListener("pointerup", (e) => {
    if (btn._pid !== e.pointerId) return;
    stop(); onEnd();
  });
}

function startAutoSequence() {
  if (autoStarted || !armGroup) return;
  autoStarted = true;
  autoStep = 1;
  autoT = 0;
  dropStartY = armGroup.position.y;
}

// ボタン設定
bindHoldMove(arrowBtn1,
  () => { holdMove.x = +ARM_HOLD_SPEED_X; holdMove.z = 0; },
  () => {
    if (phase === 0) {
      arrowBtn1.setEnabled(false);
      arrowBtn2.setEnabled(true);
      phase = 1;
    }
  }
);
bindHoldMove(arrowBtn2,
  () => { holdMove.x = 0; holdMove.z = -ARM_HOLD_SPEED_Z; },
  () => {
    if (phase === 1) {
      arrowBtn1.setEnabled(false);
      arrowBtn2.setEnabled(false);
      phase = 3;
      startAutoSequence();
    }
  }
);

// Hitbox
function addHitboxVisualizer(scene, halfExtents, { color = 0x00ff00 } = {}) {
  const geo = new THREE.BoxGeometry(halfExtents.x*2, halfExtents.y*2, halfExtents.z*2);
  const mat = new THREE.MeshBasicMaterial({ color, wireframe: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 9999;
  scene.add(mesh);
  return mesh;
}
function updateHitboxFromBody(body, vis, shapeOffset, shapeOrient) {
  const off = new CANNON.Vec3();
  body.quaternion.vmult(shapeOffset, off);
  const worldPos = body.position.vadd(off);
  const worldQuat = body.quaternion.mult(shapeOrient);
  vis.position.copy(cannonVecToThree(worldPos));
  vis.quaternion.copy(cannonQuatToThree(worldQuat));
}

const clawHitboxes = [
  { half: new CANNON.Vec3(HB1.x*HB_SCALE, HB1.y*HB_SCALE, HB1.z*HB_SCALE), offset: new CANNON.Vec3(0, HB_Y, HB_Z1), orient: quatFromEuler(HB1_ROT.x, HB1_ROT.y, HB1_ROT.z) },
  { half: new CANNON.Vec3(HB2.x*HB_SCALE, HB2.y*HB_SCALE, HB2.z*HB_SCALE), offset: new CANNON.Vec3(0, HB_Y+HB_GAP1, HB_Z2), orient: quatFromEuler(HB2_ROT.x, HB2_ROT.y, HB2_ROT.z) },
  { half: new CANNON.Vec3(HB3.x*HB_SCALE, HB3.y*HB_SCALE, HB3.z*HB_SCALE), offset: new CANNON.Vec3(0, HB_Y+HB_GAP1+HB_GAP2, HB_Z3), orient: quatFromEuler(HB3_ROT.x, HB3_ROT.y, HB3_ROT.z) },
];

function makeClawPhysics() {
  armBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
  world.addBody(armBody);

  clawLBody = new CANNON.Body({ mass: 0, material: matClaw, type: CANNON.Body.KINEMATIC });
  clawRBody = new CANNON.Body({ mass: 0, material: matClaw, type: CANNON.Body.KINEMATIC });

  for (const m of clawLVis) scene.remove(m); clawLVis = [];
  for (const m of clawRVis) scene.remove(m); clawRVis = [];

  for (let i = 0; i < clawHitboxes.length; i++) {
    const hb = clawHitboxes[i];
    const shape = new CANNON.Box(hb.half);
    const offL = new CANNON.Vec3(hb.offset.x, hb.offset.y, hb.offset.z * HB_Z_SIGN_L);
    const offR = new CANNON.Vec3(hb.offset.x, hb.offset.y, hb.offset.z * HB_Z_SIGN_R);
    
    clawLBody.addShape(shape, offL, hb.orient);
    clawRBody.addShape(shape, offR, hb.orient);

    clawLVis.push(addHitboxVisualizer(scene, hb.half, { color: 0x00ff00 }));
    clawRVis.push(addHitboxVisualizer(scene, hb.half, { color: 0xff0000 }));
  }
  world.addBody(clawLBody);
  world.addBody(clawRBody);
}

function updateClawHitboxVisuals() {
  if (!clawLBody || !clawRBody) return;
  for (let i = 0; i < clawHitboxes.length; i++) {
    const hb = clawHitboxes[i];
    const offL = new CANNON.Vec3(hb.offset.x, hb.offset.y, hb.offset.z * HB_Z_SIGN_L);
    const offR = new CANNON.Vec3(hb.offset.x, hb.offset.y, hb.offset.z * HB_Z_SIGN_R);
    updateHitboxFromBody(clawLBody, clawLVis[i], offL, hb.orient);
    updateHitboxFromBody(clawRBody, clawRVis[i], offR, hb.orient);
  }
}

function makeStickHalfExtentsFromMesh(stickMesh, thicknessRatio=0.04) {
  stickMesh.updateWorldMatrix(true, true);
  const s = getBoxSize(stickMesh);
  const axes = [{k:"x",v:s.x}, {k:"y",v:s.y}, {k:"z",v:s.z}].sort((a,b)=>b.v-a.v);
  const longAxis = axes[0].k;
  const half = { x:s.x/2, y:s.y/2, z:s.z/2 };
  for(const k of ["x","y","z"]) if(k!==longAxis) half[k]*=thicknessRatio;
  return new CANNON.Vec3(half.x, half.y, half.z);
}

function centerToOriginAndGround(root) {
  const b = getBox3(root);
  const center = new THREE.Vector3();
  b.getCenter(center);
  root.position.sub(center);
  const b2 = getBox3(root);
  root.position.y -= b2.min.y;
}
function boxTopCenterWorld(box) {
  return new THREE.Vector3((box.min.x+box.max.x)*0.5, box.max.y, (box.min.z+box.max.z)*0.5);
}
function placePivotAtWorld(pivot, parent, worldPoint) {
  const p = worldPoint.clone();
  parent.worldToLocal(p);
  pivot.position.copy(p);
}
function addDebugDotLocal(parent, localPos, size=0.03) {
  const geo = new THREE.SphereGeometry(size, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest:false, depthWrite:false });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(localPos);
  parent.add(m);
  return m;
}

// ===== Load =====
async function loadScene() {
  const [stickGltf, boxGltf, craneGltf, armGltf, clawLGltf, clawRGltf] = await Promise.all([
    loader.loadAsync("./models/Stick.glb"),
    loader.loadAsync("./models/box.glb"),
    loader.loadAsync("./models/Crane_game.glb"),
    loader.loadAsync("./models/Arm_unit.glb"),
    loader.loadAsync("./models/ClawL.glb"),
    loader.loadAsync("./models/ClawR.glb"),
  ]);

  armMesh = armGltf.scene;
  clawLMesh = clawLGltf.scene;
  clawRMesh = clawRGltf.scene;

  armMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE * ARM_BODY_SCALE);
  clawLMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE * CLAW_SCALE);
  clawRMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE * CLAW_SCALE);

  clawPivot = new THREE.Object3D();
  armMesh.add(clawPivot);
  clawPivot.position.set(0.0, 0.25, 0.0);

  clawLPivot = new THREE.Object3D();
  clawRPivot = new THREE.Object3D();
  clawPivot.add(clawLPivot);
  clawPivot.add(clawRPivot);
  clawLPivot.position.set(0, -1.95, 0.3);
  clawRPivot.position.set(0, -1.95, -0.3);

  clawLPivot.add(clawLMesh);
  clawRPivot.add(clawRMesh);

  const boxL = getBoxWorld(clawLMesh);
  const boxR = getBoxWorld(clawRMesh);
  const hingeL_world = boxTopCenterWorld(boxL);
  const hingeR_world = boxTopCenterWorld(boxR);
  placePivotAtWorld(clawLPivot, clawPivot, hingeL_world);
  placePivotAtWorld(clawRPivot, clawPivot, hingeR_world);
  
  const hingeL_local = clawPivot.worldToLocal(hingeL_world.clone());
  const hingeR_local = clawPivot.worldToLocal(hingeR_world.clone());
  addDebugDotLocal(clawPivot, hingeL_local, 0.03);
  addDebugDotLocal(clawPivot, hingeR_local, 0.03);

  clawLMesh.position.set(0, -1.95, -0.2);
  clawRMesh.position.set(0, -1.85, -0.2);

  armGroup = new THREE.Group();
  armGroup.add(armMesh);
  armGroup.position.set(HOME_X, 1.6, HOME_Z);
  armGroup.rotation.y = Math.PI/2;
  scene.add(armGroup);

  makeClawPhysics();
  setClawOpen01(0);

  craneMesh = craneGltf.scene;
  craneMesh.scale.setScalar(WORLD_SCALE);
  centerToOriginAndGround(craneMesh);
  craneMesh.position.y -= 2;
  scene.add(craneMesh);

  stick1Mesh = stickGltf.scene.clone(true);
  stick2Mesh = stickGltf.scene.clone(true);
  stick3Mesh = stickGltf.scene.clone(true);
  stick4Mesh = stickGltf.scene.clone(true);
  boxMesh = boxGltf.scene;

  const s = WORLD_SCALE;
  stick1Mesh.scale.setScalar(s); stick2Mesh.scale.setScalar(s);
  stick3Mesh.scale.setScalar(s); stick4Mesh.scale.setScalar(s);
  boxMesh.scale.setScalar(s);
  
  scene.add(stick1Mesh, stick2Mesh, stick3Mesh, stick4Mesh, boxMesh);
  
  const stickGap = 0.5;
  stick1Mesh.position.set(0, 0, -stickGap/2);
  stick2Mesh.position.set(0, 0, stickGap/2);
  
  const highY = 0.3; const highGap = 1.1;
  stick3Mesh.position.set(0, highY, -highGap/2);
  stick4Mesh.position.set(0, highY, highGap/2);

  const stickHalf1 = makeStickHalfExtentsFromMesh(stick1Mesh);
  const stickHalf2 = makeStickHalfExtentsFromMesh(stick2Mesh);
  const stickHalf3 = makeStickHalfExtentsFromMesh(stick3Mesh);
  const stickHalf4 = makeStickHalfExtentsFromMesh(stick4Mesh);

  const yaw = Math.PI/2;
  stick1Mesh.rotation.y += yaw; stick2Mesh.rotation.y += yaw;
  stick3Mesh.rotation.y += yaw; stick4Mesh.rotation.y += yaw;
  boxMesh.rotation.y += yaw;

  stick1Body = new CANNON.Body({ mass:0, material:matStick }); stick1Body.addShape(new CANNON.Box(stickHalf1)); stick1Body.position.copy(stick1Mesh.position); stick1Body.quaternion.copy(stick1Mesh.quaternion); world.addBody(stick1Body);
  stick2Body = new CANNON.Body({ mass:0, material:matStick }); stick2Body.addShape(new CANNON.Box(stickHalf2)); stick2Body.position.copy(stick2Mesh.position); stick2Body.quaternion.copy(stick2Mesh.quaternion); world.addBody(stick2Body);
  stick3Body = new CANNON.Body({ mass:0, material:matStick }); stick3Body.addShape(new CANNON.Box(stickHalf3)); stick3Body.position.copy(stick3Mesh.position); stick3Body.quaternion.copy(stick3Mesh.quaternion); world.addBody(stick3Body);
  stick4Body = new CANNON.Body({ mass:0, material:matStick }); stick4Body.addShape(new CANNON.Box(stickHalf4)); stick4Body.position.copy(stick4Mesh.position); stick4Body.quaternion.copy(stick4Mesh.quaternion); world.addBody(stick4Body);

  const boxSize = getBoxSize(boxMesh);
  const boxHalf = new CANNON.Vec3(boxSize.x/2, boxSize.y/2, boxSize.z/2);
  boxBody = new CANNON.Body({ mass:1.0, material:matBox, linearDamping:0.01, angularDamping:0.02 });
  boxBody.addShape(new CANNON.Box(boxHalf));
  boxBody.position.set(0, 0.5, 0);
  boxBody.quaternion.copy(boxMesh.quaternion);
  world.addBody(boxBody);
  boxMesh.position.copy(boxBody.position);

  camera.lookAt(0, 0.4, 0);
}

function getBoxWorld(obj) { obj.updateWorldMatrix(true,true); return new THREE.Box3().setFromObject(obj); }
loadScene().catch(console.error);

let lastT;
const prevClawL = new CANNON.Vec3();
const prevClawR = new CANNON.Vec3();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

function followClawBodies(dt) {
  if (!armBody || !clawLBody || !clawRBody) return;
  if (!armGroup || !clawLPivot || !clawRPivot) return;

  prevClawL.copy(clawLBody.position);
  prevClawR.copy(clawRBody.position);

  clawLPivot.updateWorldMatrix(true, false);
  clawLPivot.getWorldPosition(tmpPos);
  clawLPivot.getWorldQuaternion(tmpQuat);
  clawLBody.position.copy(threeVecToCannon(tmpPos));
  clawLBody.quaternion.copy(threeQuatToCannon(tmpQuat));

  clawRPivot.updateWorldMatrix(true, false);
  clawRPivot.getWorldPosition(tmpPos);
  clawRPivot.getWorldQuaternion(tmpQuat);
  clawRBody.position.copy(threeVecToCannon(tmpPos));
  clawRBody.quaternion.copy(threeQuatToCannon(tmpQuat));

  if (dt > 1e-6) {
    clawLBody.velocity.set((clawLBody.position.x - prevClawL.x)/dt, (clawLBody.position.y - prevClawL.y)/dt, (clawLBody.position.z - prevClawL.z)/dt);
    clawRBody.velocity.set((clawRBody.position.x - prevClawR.x)/dt, (clawRBody.position.y - prevClawR.y)/dt, (clawRBody.position.z - prevClawR.z)/dt);
  }
  clawLBody.angularVelocity.set(0, 0, 0);
  clawRBody.angularVelocity.set(0, 0, 0);
}

function animate(t) {
  requestAnimationFrame(animate);
  if (lastT == null) lastT = t;
  const dt = Math.min((t - lastT) / 1000, 1/60);
  lastT = t;

  if (armGroup) {
    armGroup.position.x += holdMove.x * dt;
    armGroup.position.z += holdMove.z * dt;
    if (holdMove.x > 0 && armGroup.position.x >= ARM_MAX_X) { armGroup.position.x = ARM_MAX_X; holdMove.x = 0; }
    if (holdMove.z < 0 && armGroup.position.z <= ARM_MIN_Z) { armGroup.position.z = ARM_MIN_Z; holdMove.z = 0; }
  }

  if (autoStarted) {
    // 1. 開く
    if (autoStep === 1) {
      autoT += dt;
      setClawOpen01(Math.min(autoT/CLAW_OPEN_TIME, 1));
      if (autoT >= CLAW_OPEN_TIME) { autoStep = 2; autoT = 0; dropStartY = armGroup.position.y; }
    }
    // 2. 下げる
    else if (autoStep === 2) {
      const targetY = dropStartY - ARM_DROP_DIST;
      armGroup.position.y = Math.max(targetY, armGroup.position.y - ARM_DROP_SPEED * dt);
      if (armGroup.position.y <= targetY + 1e-6) { autoStep = 3; autoT = 0; }
    }
    // 3. 閉じる
    else if (autoStep === 3) {
      autoT += dt;
      setClawOpen01(1 - Math.min(autoT/CLAW_CLOSE_TIME, 1));
      if (autoT >= CLAW_CLOSE_TIME) { autoStep = 4; }
    }
    // 4. 上昇
    else if (autoStep === 4) {
      const targetY = dropStartY;
      armGroup.position.y = Math.min(targetY, armGroup.position.y + ARM_DROP_SPEED * dt);
      if (armGroup.position.y >= targetY - 1e-6) { autoStep = 5; }
    }
    // 5. 戻る (★速度調整)
    else if (autoStep === 5) {
      // ★ここでゆっくりにします
      const speed = ARM_MOVE_SPEED * RETURN_SPEED_RATIO * dt;
      if (armGroup.position.x > HOME_X) armGroup.position.x = Math.max(HOME_X, armGroup.position.x - speed);
      if (armGroup.position.z < HOME_Z) armGroup.position.z = Math.min(HOME_Z, armGroup.position.z + speed);
      if (Math.abs(armGroup.position.x - HOME_X) < 0.05 && Math.abs(armGroup.position.z - HOME_Z) < 0.05) {
         autoStep = 6; autoT = 0;
      }
    }
    // 6. 開く (景品リリース)
    else if (autoStep === 6) {
      autoT += dt;
      setClawOpen01(Math.min(autoT/CLAW_OPEN_TIME, 1));
      if (autoT >= CLAW_OPEN_TIME + 0.5) { 
        autoStep = 7; // ★リセットへ
        autoT = 0;
      }
    }
    // 7. 閉じる (★新規追加：初期状態に戻す)
    else if (autoStep === 7) {
      autoT += dt;
      setClawOpen01(1 - Math.min(autoT/CLAW_CLOSE_TIME, 1));
      if (autoT >= CLAW_CLOSE_TIME) {
        // 全リセット
        autoStarted = false;
        autoStep = 0;
        phase = 0;
        arrowBtn1.setEnabled(true);
        setClawOpen01(0); // 完全に閉じる
      }
    }
  }

  if (armGroup && armBody) {
    const prev = armBody.position.clone();
    armBody.position.set(armGroup.position.x, armGroup.position.y, armGroup.position.z);
    armBody.quaternion.copy(armGroup.quaternion);
    if (dt > 1e-6) {
      armBody.velocity.set((armBody.position.x - prev.x)/dt, (armBody.position.y - prev.y)/dt, (armBody.position.z - prev.z)/dt);
    }
    armBody.angularVelocity.set(0, 0, 0);
  }

  followClawBodies(dt);
  updateClawHitboxVisuals();

  const FIXED = 1/60;
  world.step(FIXED, dt, 10);

  if (boxMesh && boxBody) {
    boxMesh.position.copy(boxBody.position);
    boxMesh.quaternion.copy(boxBody.quaternion);
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
