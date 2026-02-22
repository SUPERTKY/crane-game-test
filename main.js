
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const WORLD_SCALE = 0.25;
const ARM_BODY_SCALE = 0.7; // 本体だけ（小さくしたいなら 0.6〜1.0）
const CLAW_SCALE     = 1.5; // 爪だけ（必要なら調整）
const ARM_SCALE = 2; // ←ここを 1.2〜2.0 で調整
const ARM_ROT_SPEED = 0.8; // rad/sec（0.2〜2.0で調整）
let CLAW_AXIS = "x";   // "x" | "y" | "z" を試す
let CLAW_SIGN = 1;     // 1 か -1 を試す（逆なら -1）
const ARM_MOVE_SPEED = 1.2; // 1秒あたりの移動速度（大きいほど速い）
const ARM_HOLD_SPEED_X = 0.6; // 横移動速度（1秒あたり）
const ARM_HOLD_SPEED_Z = 0.6; // 前移動速度（1秒あたり）
const SHOW_PHYSICS_DEBUG = true;
const CONTACT_DEBUG_LIMIT = 80;
const BOX_YAW = Math.PI / 2;
const STICK_VISUAL_POST_ROT = { x: Math.PI / 2, y: 0, z: 0 };
const STICK_BODY_POST_ROT = { x: Math.PI / 2, y: 0, z: 0 };
// 例：到達点（好きに調整）
const ARM_MAX_X = 1.2;   // →でここまで
const ARM_MIN_Z = -1.0;  // ↑(z-)でここまで
// 左右それぞれ別の角度（ラジアン）
const CLAW_L_CLOSED = 0.4;
const CLAW_L_OPEN   = -0.3;






// ===== 爪ヒットボックス：メッシュ頂点からConvexPolyhedronを生成 =====
const BOX_SCALE = 0.8; // 例：1.3倍（小さくするなら 0.8 など）

function geometryToBodyLocalConvex(mesh, bodyWorldPos, invBodyWorldQuat) {
  const posAttr = mesh.geometry?.attributes?.position;
  if (!posAttr || posAttr.count < 4) return null;

  const indexAttr = mesh.geometry.index;
  const vertices = [];
  const faces = [];

  const worldV = new THREE.Vector3();
  const localV = new THREE.Vector3();
  const keyToNewIndex = new Map();
  const remap = new Array(posAttr.count);

  const keyFor = (v) => `${v.x.toFixed(5)}|${v.y.toFixed(5)}|${v.z.toFixed(5)}`;

  for (let i = 0; i < posAttr.count; i++) {
    worldV.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    localV.copy(worldV).sub(bodyWorldPos).applyQuaternion(invBodyWorldQuat);

    const k = keyFor(localV);
    const existing = keyToNewIndex.get(k);
    if (existing !== undefined) {
      remap[i] = existing;
      continue;
    }

    const newIndex = vertices.length;
    keyToNewIndex.set(k, newIndex);
    remap[i] = newIndex;
    vertices.push(new CANNON.Vec3(localV.x, localV.y, localV.z));
  }

  const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;
  for (let t = 0; t < triCount; t++) {
    const ia = indexAttr ? indexAttr.getX(t * 3) : t * 3;
    const ib = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    const a = remap[ia];
    const b = remap[ib];
    const c = remap[ic];
    if (a === b || b === c || c === a) continue;
    faces.push([a, b, c]);
  }

  if (vertices.length < 4 || faces.length < 4) return null;

    const shape = new CANNON.ConvexPolyhedron({ vertices, faces });
  const center = centerConvex(shape);

  return {
    shape,
    offset: center, // ★ ここが重要
    orient: new CANNON.Quaternion(0, 0, 0, 1),
  };

}
function computeClawBoxes(meshRoot, {
  // 小さくして引っかかりを減らす（橋渡しなら有効）
  shrink = 0.98,
  // あまり小さい箱は無視（ノイズ対策）
  minSize = 0.01,
} = {}) {
  meshRoot.updateMatrixWorld(true);

  const rootWorldPos = new THREE.Vector3();
  const rootWorldQuat = new THREE.Quaternion();
  meshRoot.getWorldPosition(rootWorldPos);
  meshRoot.getWorldQuaternion(rootWorldQuat);
  const invRootWorldQuat = rootWorldQuat.clone().invert();

  const shapes = [];
  const box3 = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  meshRoot.traverse((obj) => {
    if (!obj.isMesh) return;

    // メッシュのワールドAABB
    box3.setFromObject(obj);
    box3.getSize(size);

    if (size.x < minSize && size.y < minSize && size.z < minSize) return;

    box3.getCenter(center);

    // root ローカルへ（Cannon bodyローカルと同じ扱い）
    const localCenter = center.clone().sub(rootWorldPos).applyQuaternion(invRootWorldQuat);

    const half = new CANNON.Vec3(
      Math.max(minSize, (size.x * shrink) / 2),
      Math.max(minSize, (size.y * shrink) / 2),
      Math.max(minSize, (size.z * shrink) / 2)
    );

    shapes.push({
      shape: new CANNON.Box(half),
      offset: new CANNON.Vec3(localCenter.x, localCenter.y, localCenter.z),
      orient: new CANNON.Quaternion(0, 0, 0, 1),
    });
  });

  return shapes;
}
function makeStickCylinderParamsFixedX(stickMesh, radiusScale = 0.5) {
  stickMesh.updateWorldMatrix(true, true);
  const s = getBoxSize(stickMesh);

  const dims = [s.x, s.y, s.z];
  const longestAxis = dims.indexOf(Math.max(...dims)); // 0=x, 1=y, 2=z

  // 最長軸をCylinderのheight(長手)にする
  const height = Math.max(dims[longestAxis], 0.01);

  // 残り2軸から半径を算出（平べったくならないよう大きい方を採用）
  const radialAxes = [0, 1, 2].filter((axis) => axis !== longestAxis);
  const radius = Math.max(
    Math.max(dims[radialAxes[0]], dims[radialAxes[1]]) * 0.5 * radiusScale,
    0.01,
  );

  // CannonのCylinderはローカルX軸が長手。
  // 棒の最長軸に合わせてshapeローカル回転を与える。
  let orient = quatFromEuler(0, 0, 0);      // X軸
  if (longestAxis === 1) orient = quatFromEuler(0, 0, Math.PI / 2);   // Y軸
  if (longestAxis === 2) orient = quatFromEuler(0, -Math.PI / 2, 0);  // Z軸

  return { radius, height, orient };
}
function computeClawConvexHitboxes(meshRoot) {
  meshRoot.updateMatrixWorld(true);

  const bodyWorldPos = new THREE.Vector3();
  const bodyWorldQuat = new THREE.Quaternion();
  meshRoot.getWorldPosition(bodyWorldPos);
  meshRoot.getWorldQuaternion(bodyWorldQuat);
  const invBodyWorldQuat = bodyWorldQuat.clone().invert();

  const hitboxes = [];
  meshRoot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const convex = geometryToBodyLocalConvex(obj, bodyWorldPos, invBodyWorldQuat);
    if (convex) hitboxes.push(convex);
  });

  return hitboxes;
}

function computeConvexShapesFromRoot(meshRoot) {
  meshRoot.updateMatrixWorld(true);

  const bodyWorldPos = new THREE.Vector3();
  const bodyWorldQuat = new THREE.Quaternion();
  meshRoot.getWorldPosition(bodyWorldPos);
  meshRoot.getWorldQuaternion(bodyWorldQuat);
  const invBodyWorldQuat = bodyWorldQuat.clone().invert();

  const shapes = [];
  meshRoot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const convex = geometryToBodyLocalConvex(obj, bodyWorldPos, invBodyWorldQuat);
    if (convex) shapes.push(convex);
  });

  return shapes;
}

/**
 * 爪全体のAABBから「先端側だけ」を切り出した単純Boxを作る。
 * 複雑な複数AABBより安定し、Cannonの接触が破綻しにくい。
 */
function computeClawFingerBox(meshRoot, {
  shrinkXZ = 0.55,
  tipHeightRatio = 0.48,
  minHalf = 0.01,
} = {}) {
  meshRoot.updateWorldMatrix(true, true);

  const rootWorldPos = new THREE.Vector3();
  const rootWorldQuat = new THREE.Quaternion();
  meshRoot.getWorldPosition(rootWorldPos);
  meshRoot.getWorldQuaternion(rootWorldQuat);
  const invRootWorldQuat = rootWorldQuat.clone().invert();

  const worldBox = new THREE.Box3().setFromObject(meshRoot);
  const size = new THREE.Vector3();
  worldBox.getSize(size);

  const tipCenterWorld = new THREE.Vector3(
    (worldBox.min.x + worldBox.max.x) * 0.5,
    worldBox.min.y + size.y * (tipHeightRatio * 0.5),
    (worldBox.min.z + worldBox.max.z) * 0.5,
  );

  const localCenter = tipCenterWorld
    .clone()
    .sub(rootWorldPos)
    .applyQuaternion(invRootWorldQuat);

  const half = new CANNON.Vec3(
    Math.max(minHalf, (size.x * shrinkXZ) * 0.5),
    Math.max(minHalf, (size.y * tipHeightRatio) * 0.5),
    Math.max(minHalf, (size.z * shrinkXZ) * 0.5),
  );

  return {
    shape: new CANNON.Box(half),
    offset: new CANNON.Vec3(localCenter.x, localCenter.y, localCenter.z),
    orient: new CANNON.Quaternion(0, 0, 0, 1),
  };
}


function quatFromEuler(x, y, z) {
  const q = new CANNON.Quaternion();
  q.setFromEuler(x, y, z, "XYZ");
  return q;
}

const CLAW_R_CLOSED = -0.6;
const CLAW_R_OPEN   = 0.2;
// ===== 自動シーケンス設定 =====
const CLAW_OPEN_TIME = 0.6;   // 開くのにかける秒
const ARM_DROP_DIST  = 1;  // 下げる距離（Y方向）
const ARM_DROP_SPEED = 0.22;   // 下げる速さ（1秒あたり）
const CLAW_CLOSE_TIME = 1.8;  // 閉じるのにかける秒（遅くして押し込みを軽減）

let autoStep = 0;     // 0=待機, 1=開く, 2=下げる, 3=閉じる, 4=上げる, 5=完了
let autoT = 0;
let dropStartY = 0;
let autoStarted = false;

// ===== つかみ（Constraint）設定 =====
const ARM_RISE_SPEED = 0.4;  // 上昇の速さ（1秒あたり）。ゆっくりめが自然

let holdMove = { x: 0, z: 0 }; // 押してる間の移動方向
let phase = 0; // 0:→のみ / 1:↑のみ / 2:→のみ(最後) / 3:全部無効




const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 2, 3.2);
camera.lookAt(0, 0.4, 0);
// ===== カメラ切替ボタン =====
const camBtn = document.createElement("button");
camBtn.type = "button";
camBtn.title = "カメラ切替";
camBtn.style.position = "fixed";
camBtn.style.right = "18px";
camBtn.style.bottom = "18px";
camBtn.style.width = "100px";
camBtn.style.height = "100px";
camBtn.style.padding = "0";
camBtn.style.border = "none";
camBtn.style.borderRadius = "12px";
camBtn.style.background = "rgba(255,255,255,0.85)";
camBtn.style.boxShadow = "0 6px 18px rgba(0,0,0,0.18)";
camBtn.style.cursor = "pointer";
camBtn.style.display = "grid";
camBtn.style.placeItems = "center";
camBtn.style.userSelect = "none";
camBtn.style.zIndex = "9999";

const camImg = document.createElement("img");
camImg.src = "./assets/camera.png";
camImg.alt = "camera";
camImg.style.width = "70%";
camImg.style.height = "70%";
camImg.style.pointerEvents = "none";
camBtn.appendChild(camImg);

document.body.appendChild(camBtn);

// ===== カメラ切替ロジック =====
const FRONT_POS = new THREE.Vector3(0, 2, 3.2);
const RIGHT_POS = new THREE.Vector3(3.2, 2, 0);
const LOOK_AT = new THREE.Vector3(0, 0.4, 0);
// ===== 中央ボタンコンテナ =====
const arrowUI = document.createElement("div");
arrowUI.style.position = "fixed";
arrowUI.style.left = "50%";
arrowUI.style.top = "75%";
arrowUI.style.transform = "translate(-50%, -50%)";
arrowUI.style.display = "flex";
arrowUI.style.gap = "18px";
arrowUI.style.zIndex = "9999";

document.body.appendChild(arrowUI);
function setClawOpen01(open01) {
  // 0=閉, 1=開
  const l = THREE.MathUtils.lerp(CLAW_L_CLOSED, CLAW_L_OPEN, open01);
  const r = THREE.MathUtils.lerp(CLAW_R_CLOSED, CLAW_R_OPEN, open01);

  clawLPivot.rotation.x = l; // ←軸は合うやつに（x/y/z）
  clawRPivot.rotation.x = r;
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

// ===== 物理 =====
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = false;
world.defaultContactMaterial.friction = 0.35;
world.defaultContactMaterial.restitution = 0.0;

const matStick = new CANNON.Material("stick");
const matBox = new CANNON.Material("box");
const matClaw = new CANNON.Material("claw");

world.solver.iterations = 20;
world.solver.tolerance = 0.001;

world.addContactMaterial(
  new CANNON.ContactMaterial(matStick, matBox, {
    friction: 0.05,
    restitution: 0.0,
  })
);

world.addContactMaterial(
  new CANNON.ContactMaterial(matClaw, matBox, {
    friction: 0.18,
    restitution: 0.0,
    contactEquationStiffness: 8e4,
    contactEquationRelaxation: 12,
    frictionEquationStiffness: 7e4,
    frictionEquationRelaxation: 12,
  })
);

const loader = new GLTFLoader();

let boxMesh, stick1Mesh, stick2Mesh, craneMesh;
let boxBody, stick1Body, stick2Body;
let stick3Mesh, stick4Mesh;
let stick3Body, stick4Body;

function getBox3(obj3d) {
  return new THREE.Box3().setFromObject(obj3d);
}
function getBoxSize(obj3d) {
  const size = new THREE.Vector3();
  getBox3(obj3d).getSize(size);
  return size;
}

/** 見た目の中心を(0,0,0)へ寄せ、床面(Y最下)を0へ揃える */
function centerToOriginAndGround(root) {
  const b = getBox3(root);
  const center = new THREE.Vector3();
  b.getCenter(center);

  root.position.sub(center);

  const b2 = getBox3(root);
  root.position.y -= b2.min.y;
}


function makeArrowButton(rotationDeg = 0) {
  const btn = document.createElement("button");
  btn.type = "button";

  btn.style.width = "100px";
  btn.style.height = "100px";
  btn.style.border = "none";
  btn.style.padding = "0";
  btn.style.margin = "0";
  btn.style.background = "transparent";
  btn.style.boxShadow = "none";
  btn.style.cursor = "pointer";
  btn.style.display = "grid";
  btn.style.placeItems = "center";
  btn.style.userSelect = "none";

  const img = document.createElement("img");
  img.src = "./assets/Arrow.png";
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.transform = `rotate(${rotationDeg}deg)`;
  img.style.pointerEvents = "none";
  btn.appendChild(img);

  // ★ 有効/無効の見た目＆操作をまとめて切替
  btn.setEnabled = (enabled) => {
    btn.disabled = !enabled; // クリック無効化（標準）
    btn.style.pointerEvents = enabled ? "auto" : "none"; // 念のため
    btn.style.opacity = enabled ? "1" : "0.45";          // 少し黒っぽく（暗く）
    btn.style.filter  = enabled ? "none" : "grayscale(1) brightness(0.7)";
    btn.style.cursor  = enabled ? "pointer" : "default";
  };

  return btn;
}


const arrowBtn1 = makeArrowButton(0);    // →（回転なし）
const arrowBtn2 = makeArrowButton(-90);   // ↑（90度回転）

arrowUI.appendChild(arrowBtn1);
arrowUI.appendChild(arrowBtn2);

// 初期：→だけ押せる
arrowBtn1.setEnabled(true);
arrowBtn2.setEnabled(false);

// 長押し開始/終了をまとめる関数
function bindHoldMove(btn, onStart, onEnd) {
  const stop = () => {
    holdMove.x = 0;
    holdMove.z = 0;
    btn.releasePointerCapture?.(btn._pid);
    btn._pid = null;
  };

  btn.addEventListener("pointerdown", (e) => {
    if (btn.disabled) return;
    e.preventDefault();

    btn._pid = e.pointerId;
    btn.setPointerCapture?.(e.pointerId);

    onStart();
  });

  // 指を離した/外れた/キャンセルされたら止める
  btn.addEventListener("pointerup", (e) => {
    if (btn._pid !== e.pointerId) return;
    stop();
    onEnd();
  });
  btn.addEventListener("pointercancel", (e) => {
    if (btn._pid !== e.pointerId) return;
    stop();
  });
  btn.addEventListener("pointerleave", () => {
    // captureしてるならleaveは無視でもOKだけど保険で止める
    if (btn._pid != null) stop();
  });
}
function startAutoSequence() {
  if (autoStarted || !armGroup) return;
  autoStarted = true;

  autoStep = 1;   // 開くから開始
  autoT = 0;
  dropStartY = armGroup.position.y;
}

// ===== つかみConstraintは使わない（接触のみで保持） =====

// ---- →（回転なし）：横移動（長押し）----
bindHoldMove(
  arrowBtn1,
  () => {
    // 押してる間ずっと横移動（＋x）
    holdMove.x = +ARM_HOLD_SPEED_X;
    holdMove.z = 0;
  },
  () => {
    // 離した瞬間にフェーズ進行
    if (phase === 0) {
      arrowBtn1.setEnabled(false);
      arrowBtn2.setEnabled(true);
      phase = 1;
    } else if (phase === 2) {
      // 最後の→が終わったら全部無効
      arrowBtn1.setEnabled(false);
      arrowBtn2.setEnabled(false);
      phase = 3;
    }
  }
);

// ---- ↑（回転あり）：前移動（長押し）----
bindHoldMove(
  arrowBtn2,
  () => {
    holdMove.x = 0;
    holdMove.z = -ARM_HOLD_SPEED_Z;
  },
  () => {
    if (phase === 1) {
      // ↑が終わったら両方無効
      arrowBtn1.setEnabled(false);
      arrowBtn2.setEnabled(false);
      phase = 3;
      startAutoSequence();
    }
  }
);
// ===== Hitbox可視化ヘルパー =====
function cannonQuatToThree(q) {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}
function cannonVecToThree(v) {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function convexToBufferGeometry(shape) {
  const positions = [];
  for (const face of shape.faces) {
    if (!face || face.length < 3) continue;
    const a = shape.vertices[face[0]];
    for (let i = 1; i < face.length - 1; i++) {
      const b = shape.vertices[face[i]];
      const c = shape.vertices[face[i + 1]];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function addHitboxVisualizer(scene, shape, { color = 0x00ff00 } = {}) {
  if (!SHOW_PHYSICS_DEBUG) return null;

  let geo;
  if (shape instanceof CANNON.Box) {
    geo = new THREE.BoxGeometry(shape.halfExtents.x * 2, shape.halfExtents.y * 2, shape.halfExtents.z * 2);
  } else if (shape instanceof CANNON.ConvexPolyhedron) {
    geo = convexToBufferGeometry(shape);
  } else {
    geo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
  }

  const mat = new THREE.MeshBasicMaterial({ color, wireframe: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 9999;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
function centerConvex(shape) {
  const min = new CANNON.Vec3(+Infinity, +Infinity, +Infinity);
  const max = new CANNON.Vec3(-Infinity, -Infinity, -Infinity);

  for (const v of shape.vertices) {
    min.x = Math.min(min.x, v.x); min.y = Math.min(min.y, v.y); min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x); max.y = Math.max(max.y, v.y); max.z = Math.max(max.z, v.z);
  }

  const center = new CANNON.Vec3(
    (min.x + max.x) * 0.5,
    (min.y + max.y) * 0.5,
    (min.z + max.z) * 0.5
  );

  // 頂点を中心まわりにシフト
  for (const v of shape.vertices) {
    v.x -= center.x;
    v.y -= center.y;
    v.z -= center.z;
  }

  return center; // これを addShape の offset にする
}


/**
 * body: CANNON.Body
 * vis: THREE.Mesh (wireframe box)
 * shapeOffset: CANNON.Vec3  (addShapeのoffsetと同じ)
 * shapeOrient: CANNON.Quaternion (addShapeのorientationと同じ。使ってなければ identity)
 */
function updateHitboxFromBody(body, vis, shapeOffset, shapeOrient) {
  if (!vis) return;
  // worldPos = body.pos + body.quat * (shapeOffset)
  const off = new CANNON.Vec3();
  body.quaternion.vmult(shapeOffset, off);

  const worldPos = body.position.vadd(off);

  // worldQuat = body.quat * shapeOrient
  const worldQuat = body.quaternion.mult(shapeOrient);

  vis.position.copy(cannonVecToThree(worldPos));
  vis.quaternion.copy(cannonQuatToThree(worldQuat));
}
// ===== ヒットボックス配列（loadScene内で自動計算される） =====
let clawLHitboxes = []; // 左爪のConvexヒットボックス（computeClawShapesで生成）
let clawRHitboxes = []; // 右爪のConvexヒットボックス（同上）




let armBody, clawLBody, clawRBody;
let hingeL, hingeR;
let clawLVis = [];
let clawRVis = [];
const physicsDebugEntries = [];
const contactDebugMeshes = [];

function createWireframeBoxMesh(halfExtents, color = 0x00ffff) {
  const geo = new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
  const mat = new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 9998;
  return mesh;
}

function addBodyDebugMeshes(body, color = 0x00ffff) {
  if (!SHOW_PHYSICS_DEBUG || !body) return;

  for (let i = 0; i < body.shapes.length; i++) {
    const shape = body.shapes[i];

    let mesh;
    if (shape instanceof CANNON.Box) {
      mesh = createWireframeBoxMesh(shape.halfExtents, color);
    } else if (shape instanceof CANNON.ConvexPolyhedron) {
      mesh = new THREE.Mesh(
        convexToBufferGeometry(shape),
        new THREE.MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
        })
      );
      mesh.renderOrder = 9998;
    } else if (shape instanceof CANNON.Cylinder) {
      const geo = new THREE.CylinderGeometry(
        shape.radiusTop,
        shape.radiusBottom,
        shape.height,
        16,
        1,
        true
      );
      geo.rotateZ(Math.PI / 2); // ThreeのY軸CylinderをCannonのX軸向きに合わせる
      mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
        })
      );
      mesh.renderOrder = 9998;
    } else {
      continue;
    }

    scene.add(mesh);
    physicsDebugEntries.push({
      body,
      shapeOffset: body.shapeOffsets[i].clone(),
      shapeOrient: body.shapeOrientations[i].clone(),
      mesh,
    });
  }
}

function updateBodyDebugMeshes() {
  if (!SHOW_PHYSICS_DEBUG) return;

  for (const entry of physicsDebugEntries) {
    updateHitboxFromBody(entry.body, entry.mesh, entry.shapeOffset, entry.shapeOrient);
  }
}

function ensureContactDebugPool(count) {
  if (!SHOW_PHYSICS_DEBUG) return;

  while (contactDebugMeshes.length < count) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.9 })
    );
    mesh.visible = false;
    mesh.renderOrder = 9999;
    scene.add(mesh);
    contactDebugMeshes.push(mesh);
  }
}

function updateContactDebugMarkers() {
  if (!SHOW_PHYSICS_DEBUG) return;

  const showCount = Math.min(world.contacts.length, CONTACT_DEBUG_LIMIT);
  ensureContactDebugPool(showCount);

  for (let i = 0; i < showCount; i++) {
    const c = world.contacts[i];
    const bi = c.bi;
    const marker = contactDebugMeshes[i];
    const p = bi.pointToWorldFrame(c.ri, new CANNON.Vec3());

    marker.visible = true;
    marker.position.set(p.x, p.y, p.z);
  }

  for (let i = showCount; i < contactDebugMeshes.length; i++) {
    contactDebugMeshes[i].visible = false;
  }
}

function makeClawPhysics() {
  armBody = new CANNON.Body({ mass: 0 });
  armBody.type = CANNON.Body.KINEMATIC;
  world.addBody(armBody);

  clawLBody = new CANNON.Body({ mass: 0, material: matClaw });
  clawLBody.type = CANNON.Body.KINEMATIC;

  clawRBody = new CANNON.Body({ mass: 0, material: matClaw });
  clawRBody.type = CANNON.Body.KINEMATIC;

  // 既存のvisがあれば消す
  for (const m of clawLVis) scene.remove(m);
  for (const m of clawRVis) scene.remove(m);
  clawLVis = [];
  clawRVis = [];

  // ★ 左爪：自動計算されたヒットボックスを追加
  for (let i = 0; i < clawLHitboxes.length; i++) {
    const hb = clawLHitboxes[i];
    clawLBody.addShape(hb.shape, hb.offset, hb.orient);
    clawLVis.push(addHitboxVisualizer(scene, hb.shape, { color: 0x00ff00 }));

  }

  // ★ 右爪：自動計算されたヒットボックスを追加
  for (let i = 0; i < clawRHitboxes.length; i++) {
    const hb = clawRHitboxes[i];
    clawRBody.addShape(hb.shape, hb.offset, hb.orient);
    clawRVis.push(addHitboxVisualizer(scene, hb.shape, { color: 0xff0000 }));

  }

  world.addBody(clawLBody);
  world.addBody(clawRBody);

  hingeL = hingeR = null;
}

function updateClawHitboxVisuals() {
  if (!SHOW_PHYSICS_DEBUG) return; // ★デバッグOFFなら何もしない

  if (!clawLBody || !clawRBody) return;

  // 左
  for (let i = 0; i < clawLHitboxes.length; i++) {
    const vis = clawLVis[i];
    if (!vis) continue; // ★nullガード
    const hb = clawLHitboxes[i];
    updateHitboxFromBody(clawLBody, vis, hb.offset, hb.orient);
    vis.visible = true;
  }

  // 右
  for (let i = 0; i < clawRHitboxes.length; i++) {
    const vis = clawRVis[i];
    if (!vis) continue; // ★nullガード
    const hb = clawRHitboxes[i];
    updateHitboxFromBody(clawRBody, vis, hb.offset, hb.orient);
    vis.visible = true;
  }
}


// クリック処理（順番制御）
function createStickBody(stickMesh, stickParams) {
  const body = new CANNON.Body({ mass: 0, material: matStick });
  const shape = new CANNON.Cylinder(stickParams.radius, stickParams.radius, stickParams.height, 24);
  body.addShape(shape, new CANNON.Vec3(0, 0, 0), stickParams.orient);
  body.position.copy(stickMesh.position);

  // 棒の姿勢は同期しない（見た目と物理を独立管理）
  body.quaternion.set(0, 0, 0, 1);
  body.angularVelocity.set(0, 0, 0);
  body.fixedRotation = true;
  body.updateMassProperties();

  world.addBody(body);
  addBodyDebugMeshes(body, 0x00ffff);
  return body;
}

function applyStickPostSyncRotation(stickMesh, stickBody, visualEuler, bodyEuler) {
  // 同期後は見た目と物理を独立して回せるようにする
  if (stickMesh && visualEuler) {
    const visualDelta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(visualEuler.x, visualEuler.y, visualEuler.z, "XYZ")
    );
    stickMesh.quaternion.multiply(visualDelta);
    stickMesh.updateMatrixWorld(true);
  }

  if (stickBody && bodyEuler) {
    const bodyDelta = quatFromEuler(bodyEuler.x, bodyEuler.y, bodyEuler.z);
    const nextQuat = stickBody.quaternion.mult(bodyDelta);
    stickBody.quaternion.copy(nextQuat);
    stickBody.aabbNeedsUpdate = true;
  }
}

let armMesh, clawLMesh, clawRMesh, armGroup;
let clawPivot, clawLPivot, clawRPivot; // ★追加（setClawOpenで使うため）
function threeVecToCannon(v) { return new CANNON.Vec3(v.x, v.y, v.z); }
function threeQuatToCannon(q) { return new CANNON.Quaternion(q.x, q.y, q.z, q.w); }

async function loadScene() {
  const [stickGltf, boxGltf, craneGltf, armGltf, clawLGltf, clawRGltf] =
    await Promise.all([
      loader.loadAsync("./models/Stick.glb"),
      loader.loadAsync("./models/box.glb"),
      loader.loadAsync("./models/Crane_game.glb"),
      loader.loadAsync("./models/Arm_unit.glb"),
      loader.loadAsync("./models/ClawL.glb"),
      loader.loadAsync("./models/ClawR.glb"),
    ]);
function addDebugDotLocal(parent, localPos, size = 0.03) {
  const geo = new THREE.SphereGeometry(size, 12, 12);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    depthTest: false,
    depthWrite: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 9999;
  m.position.copy(localPos);   // ★ローカル座標
  parent.add(m);               // ★親にぶら下げる
  return m;
}


function getBoxWorld(obj) {
  obj.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(obj); // world AABB
}

// Box3の「上端・中心（X,Zは中心）」をworld座標で返す
function boxTopCenterWorld(box) {
  return new THREE.Vector3(
    (box.min.x + box.max.x) * 0.5,
    box.max.y,
    (box.min.z + box.max.z) * 0.5
  );
}

// Box3の「内側面中心」をworldで返す
// side: "minZ" / "maxZ" / "minX" / "maxX"
function boxSideCenterWorld(box, side) {
  const cx = (box.min.x + box.max.x) * 0.5;
  const cy = (box.min.y + box.max.y) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;

  if (side === "minZ") return new THREE.Vector3(cx, cy, box.min.z);
  if (side === "maxZ") return new THREE.Vector3(cx, cy, box.max.z);
  if (side === "minX") return new THREE.Vector3(box.min.x, cy, cz);
  if (side === "maxX") return new THREE.Vector3(box.max.x, cy, cz);
  return new THREE.Vector3(cx, cy, cz);
}

// world点を parent（ここではclawPivot）のローカルにして pivot.position に置く
function placePivotAtWorld(pivot, parent, worldPoint) {
  const p = worldPoint.clone();
  parent.worldToLocal(p);
  pivot.position.copy(p);
}



// ===== アーム作成 =====
armMesh   = armGltf.scene;
clawLMesh = clawLGltf.scene;
clawRMesh = clawRGltf.scene;


// スケール：本体と爪を別にする
armMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE * ARM_BODY_SCALE);
clawLMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE * CLAW_SCALE);
clawRMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE * CLAW_SCALE);



// ===== 先端の大ピボット（アーム先端）=====
clawPivot = new THREE.Object3D();
clawPivot.name = "ClawPivot";
armMesh.add(clawPivot);
clawPivot.position.set(0.0, 0.25, 0.0); // ★先端位置（要調整）

// ===== 左右それぞれの回転ピボット =====
clawLPivot = new THREE.Object3D();
clawRPivot = new THREE.Object3D();
clawLPivot.name = "ClawLPivot";
clawRPivot.name = "ClawRPivot";
clawPivot.add(clawLPivot);
clawPivot.add(clawRPivot);

// ★ヒンジ位置（要調整）
clawLPivot.position.set(0, -1.95, 0.3);
clawRPivot.position.set(0, -1.95, -0.3);

// ===== 爪メッシュは「ピボットの子」 =====
clawLPivot.add(clawLMesh);
clawRPivot.add(clawRMesh);
;

  // ===== 左右ヒンジ（ピボット）を自動配置 =====
const boxL = getBoxWorld(clawLMesh);
const boxR = getBoxWorld(clawRMesh);

// どの点をヒンジにするかはモデル次第。
// まずは「上端中心」をヒンジ候補にする（迷ったらこれが安定）
const hingeL_world = boxTopCenterWorld(boxL);
const hingeR_world = boxTopCenterWorld(boxR);

// ピボットを clawPivot のローカルに変換して配置
placePivotAtWorld(clawLPivot, clawPivot, hingeL_world);
placePivotAtWorld(clawRPivot, clawPivot, hingeR_world);

const hingeL_local = clawPivot.worldToLocal(hingeL_world.clone());
const hingeR_local = clawPivot.worldToLocal(hingeR_world.clone());

addDebugDotLocal(clawPivot, hingeL_local, 0.03);
addDebugDotLocal(clawPivot, hingeR_local, 0.03);




// ★爪の原点がヒンジに無い場合の補正（要調整）
clawLMesh.position.set(0, -1.95, -0.2);
clawRMesh.position.set(0, -1.85, -0.2);
armGroup = new THREE.Group();
  // グループ化
armGroup.name = "ArmGroup";
armGroup.add(armMesh);
// 置き場所（左上）
armGroup.position.set(-1.2, 1.6, 0.6);
armGroup.rotation.y = Math.PI / 2;
scene.add(armGroup);

// ★★★ 爪ヒットボックス（先端のみ）を生成 ★★★
// scene に追加した後でないとワールド座標が確定しないので、ここで計算する
armGroup.updateMatrixWorld(true);
clawLHitboxes = computeClawConvexHitboxes(clawLMesh);
clawRHitboxes = computeClawConvexHitboxes(clawRMesh);

if (!clawLHitboxes.length) clawLHitboxes = [computeClawFingerBox(clawLMesh)];
if (!clawRHitboxes.length) clawRHitboxes = [computeClawFingerBox(clawRMesh)];

console.log("左爪ヒットボックス:", clawLHitboxes.length, "個");
console.log("右爪ヒットボックス:", clawRHitboxes.length, "個");

makeClawPhysics();
// 初期は閉じ
setClawOpen01(0);


  // ===== クレーン台（見た目だけ）=====
  craneMesh = craneGltf.scene;
  craneMesh.scale.setScalar(WORLD_SCALE);
  centerToOriginAndGround(craneMesh);
  craneMesh.position.y -= 2;
  scene.add(craneMesh);

  // ===== 棒＆箱（見た目）=====
  // ===== 棒＆箱（見た目）=====
stick1Mesh = stickGltf.scene.clone(true);
stick2Mesh = stickGltf.scene.clone(true);
stick3Mesh = stickGltf.scene.clone(true);
stick4Mesh = stickGltf.scene.clone(true);
boxMesh = boxGltf.scene;

stick1Mesh.scale.setScalar(WORLD_SCALE);
stick2Mesh.scale.setScalar(WORLD_SCALE);
stick3Mesh.scale.setScalar(WORLD_SCALE);
stick4Mesh.scale.setScalar(WORLD_SCALE);
boxMesh.scale.setScalar(WORLD_SCALE * BOX_SCALE);


// まず scene 追加
scene.add(stick1Mesh, stick2Mesh, stick3Mesh, stick4Mesh, boxMesh);

// ---- 位置（回転前でもOK）----
const stickGap = 0.5;   // 低い橋の間隔
stick1Mesh.position.set(0, 0, -stickGap / 2);
stick2Mesh.position.set(0, 0,  stickGap / 2);

const highY = 0.3;      // 高さ
const highGap = 1.1;    // ★「幅」= 2本の距離（橋より大きく）
stick3Mesh.position.set(0, highY, -highGap / 2);
stick4Mesh.position.set(0, highY,  highGap / 2);

// 棒の3Dモデル回転は一旦適用しない（見た目だけの回転処理を無効化）

// ===== 物理：棒（静的・円柱）=====
// 先に棒の物理ボディを生成（見た目姿勢とは同期しない）
stick1Body = createStickBody(stick1Mesh, makeStickCylinderParamsFixedX(stick1Mesh));
stick2Body = createStickBody(stick2Mesh, makeStickCylinderParamsFixedX(stick2Mesh));
stick3Body = createStickBody(stick3Mesh, makeStickCylinderParamsFixedX(stick3Mesh));
stick4Body = createStickBody(stick4Mesh, makeStickCylinderParamsFixedX(stick4Mesh));

// 見た目と物理の両方に同じX軸90°回転を別々に適用する（同期なし）
applyStickPostSyncRotation(stick1Mesh, stick1Body, STICK_VISUAL_POST_ROT, STICK_BODY_POST_ROT);
applyStickPostSyncRotation(stick2Mesh, stick2Body, STICK_VISUAL_POST_ROT, STICK_BODY_POST_ROT);
applyStickPostSyncRotation(stick3Mesh, stick3Body, STICK_VISUAL_POST_ROT, STICK_BODY_POST_ROT);
applyStickPostSyncRotation(stick4Mesh, stick4Body, STICK_VISUAL_POST_ROT, STICK_BODY_POST_ROT);

// 箱の見た目回転
boxMesh.rotation.y += BOX_YAW;
  // ===== 物理：箱（動的）=====
  // 見た目と一致するよう、モデルメッシュ由来のConvex形状を優先して使う
  boxBody = new CANNON.Body({
    mass: 1.0,
    material: matBox,
    linearDamping: 0.08,
    angularDamping: 0.12,
    allowSleep: false,
    sleepSpeedLimit: 0.15,
    sleepTimeLimit: 0.8,
  });

  const boxSize = getBoxSize(boxMesh);
  const boxHalfHeight = Math.max(boxSize.y * 0.5, 0.01);
  const topStickY = highY;
  const spawnClearance = 0.03;
  boxMesh.position.set(0, topStickY + boxHalfHeight + spawnClearance, 0);
  boxMesh.updateMatrixWorld(true);

  const boxShapes = computeConvexShapesFromRoot(boxMesh);
  if (boxShapes.length) {
    for (const shapeDef of boxShapes) {
      boxBody.addShape(shapeDef.shape, shapeDef.offset, shapeDef.orient);
    }
  } else {
    const boxHalf = new CANNON.Vec3(
      Math.max(boxSize.x / 2, 0.01),
      Math.max(boxSize.y / 2, 0.01),
      Math.max(boxSize.z / 2, 0.01)
    );
    boxBody.addShape(new CANNON.Box(boxHalf));
  }

  boxBody.position.copy(boxMesh.position);
  boxBody.quaternion.copy(boxMesh.quaternion);
  world.addBody(boxBody);
  addBodyDebugMeshes(boxBody, 0xff00ff);

  boxMesh.position.copy(boxBody.position);

  camera.lookAt(0, 0.4, 0);
}
let clawOpen01 = 0; // 0=閉じる, 1=開く

function clawOpenMotor() {
  if (!hingeL || !hingeR) return;
  hingeL.enableMotor();
  hingeR.enableMotor();
  hingeL.setMotorSpeed(+2.0);
  hingeR.setMotorSpeed(-2.0);
}

function clawCloseMotor() {
  if (!hingeL || !hingeR) return;
  hingeL.enableMotor();
  hingeR.enableMotor();
  hingeL.setMotorSpeed(-2.0);
  hingeR.setMotorSpeed(+2.0);
}

function clawStopMotor() {
  if (!hingeL || !hingeR) return;
  hingeL.setMotorSpeed(0);
  hingeR.setMotorSpeed(0);
}


loadScene().catch(console.error);

let lastT;
const clawL_local = new CANNON.Vec3(0, -0.25,  0.12);
const clawR_local = new CANNON.Vec3(0, -0.25, -0.12);





const MAX_KINEMATIC_SPEED = 0.8;
const CONTACT_KINEMATIC_SPEED = 0.22;

function clampBodyLinearVelocity(body, maxSpeed = MAX_KINEMATIC_SPEED) {
  const vx = body.velocity.x;
  const vy = body.velocity.y;
  const vz = body.velocity.z;
  const speedSq = vx * vx + vy * vy + vz * vz;
  const maxSq = maxSpeed * maxSpeed;
  if (speedSq <= maxSq) return;

  const scale = maxSpeed / Math.sqrt(speedSq);
  body.velocity.set(vx * scale, vy * scale, vz * scale);
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const prevClawL = new CANNON.Vec3();
const prevClawR = new CANNON.Vec3();

function isClawPressingSomething() {
  if (!clawLBody || !clawRBody) return false;

  for (const c of world.contacts) {
    const bi = c.bi;
    const bj = c.bj;
    const clawHit = (bi === clawLBody || bi === clawRBody || bj === clawLBody || bj === clawRBody);
    if (!clawHit) continue;

    const other = bi === clawLBody || bi === clawRBody ? bj : bi;
    if (other && other !== armBody) return true;
  }
  return false;
}

function followClawBodies(dt) {
  if (!armBody || !clawLBody || !clawRBody) return;
  if (!armGroup || !clawLMesh || !clawRMesh) return;

  // armBody は armGroup に同期（animate側でやっている）

  // 速度計算用（前フレームの位置を保存）
  prevClawL.copy(clawLBody.position);
  prevClawR.copy(clawRBody.position);

  // ★ 方法B: 爪メッシュのワールド姿勢を直接使う
  //    ピボットではなくメッシュ自体を追跡するので、
  //    メッシュの position 補正やスケールが自動的に反映される
  clawLMesh.updateWorldMatrix(true, false);
  clawLMesh.getWorldPosition(tmpPos);
  clawLMesh.getWorldQuaternion(tmpQuat);

  clawLBody.position.copy(threeVecToCannon(tmpPos));
  clawLBody.quaternion.copy(threeQuatToCannon(tmpQuat));

  // ★ 右爪も同様にメッシュから取得
  clawRMesh.updateWorldMatrix(true, false);
  clawRMesh.getWorldPosition(tmpPos);
  clawRMesh.getWorldQuaternion(tmpQuat);

  clawRBody.position.copy(threeVecToCannon(tmpPos));
  clawRBody.quaternion.copy(threeQuatToCannon(tmpQuat));

  // 速度（kinematic安定化）
  if (dt > 1e-6) {
    clawLBody.velocity.set(
      (clawLBody.position.x - prevClawL.x) / dt,
      (clawLBody.position.y - prevClawL.y) / dt,
      (clawLBody.position.z - prevClawL.z) / dt
    );
    clawRBody.velocity.set(
      (clawRBody.position.x - prevClawR.x) / dt,
      (clawRBody.position.y - prevClawR.y) / dt,
      (clawRBody.position.z - prevClawR.z) / dt
    );
    const maxSpeed = isClawPressingSomething() ? CONTACT_KINEMATIC_SPEED : MAX_KINEMATIC_SPEED;
    clampBodyLinearVelocity(clawLBody, maxSpeed);
    clampBodyLinearVelocity(clawRBody, maxSpeed);
  }
  clawLBody.angularVelocity.set(0, 0, 0);
  clawRBody.angularVelocity.set(0, 0, 0);
}

function animate(t) {
  requestAnimationFrame(animate);

  if (lastT == null) lastT = t;
  const dt = Math.min((t - lastT) / 1000, 1 / 120);

  lastT = t;

  // ===== 長押し中のアーム移動（Three側）=====
  if (armGroup) {
    armGroup.position.x += holdMove.x * dt;
    armGroup.position.z += holdMove.z * dt;

    if (holdMove.x > 0 && armGroup.position.x >= ARM_MAX_X) {
      armGroup.position.x = ARM_MAX_X;
      holdMove.x = 0;
    }
    if (holdMove.z < 0 && armGroup.position.z <= ARM_MIN_Z) {
      armGroup.position.z = ARM_MIN_Z;
      holdMove.z = 0;
    }
  }

  // ===== 自動シーケンス（Three側）=====
  // ステップ: 1=開く → 2=下げる → 3=閉じる → 4=上げる → 5=完了
if (autoStarted) {
  if (autoStep === 1) {
    // ===== ステップ1: 爪を開く =====
    autoT += dt;
    setClawOpen01(Math.min(autoT / CLAW_OPEN_TIME, 1));
    if (autoT >= CLAW_OPEN_TIME) { autoStep = 2; autoT = 0; dropStartY = armGroup.position.y; }

  } else if (autoStep === 2) {
    // ===== ステップ2: アームを下げる =====
    const targetY = dropStartY - ARM_DROP_DIST;
    const dropSpeed = isClawPressingSomething() ? ARM_DROP_SPEED * 0.25 : ARM_DROP_SPEED;
    armGroup.position.y = Math.max(targetY, armGroup.position.y - dropSpeed * dt);
    if (armGroup.position.y <= targetY + 1e-6) { autoStep = 3; autoT = 0; }

  } else if (autoStep === 3) {
    // ===== ステップ3: 爪を閉じる =====
    autoT += isClawPressingSomething() ? dt * 0.3 : dt;
    setClawOpen01(1 - Math.min(autoT / CLAW_CLOSE_TIME, 1));
    if (autoT >= CLAW_CLOSE_TIME) {
      // 閉じ終わったらそのまま上昇（吸着はしない）
      autoStep = 4;
      autoT = 0;
    }

  } else if (autoStep === 4) {
    // ===== ステップ4: アームを元の高さまで上げる =====
    const targetY = dropStartY;
    armGroup.position.y = Math.min(targetY, armGroup.position.y + ARM_RISE_SPEED * dt);
    if (armGroup.position.y >= targetY - 1e-6) {
      armGroup.position.y = targetY;
      autoStep = 5;
    }

  } else if (autoStep === 5) {
    // ===== ステップ5: 完了 =====
    // ここに到達したら停止（必要なら景品を離す処理を追加可能）
  }
}


  // ★★★ ここがポイント：Cannon側armBodyを "step前" に同期 ★★★
  if (armGroup && armBody) {
    // kinematic安定化：速度も入れる（拘束が追従しやすい）
    const prev = armBody.position.clone();

    armBody.position.set(armGroup.position.x, armGroup.position.y, armGroup.position.z);
    armBody.quaternion.set(
      armGroup.quaternion.x,
      armGroup.quaternion.y,
      armGroup.quaternion.z,
      armGroup.quaternion.w
    );

    // 速度を入れる（dtが0に近いときは保険）
    if (dt > 1e-6) {
      armBody.velocity.set(
        (armBody.position.x - prev.x) / dt,
        (armBody.position.y - prev.y) / dt,
        (armBody.position.z - prev.z) / dt
      );
      clampBodyLinearVelocity(armBody);
    }
    armBody.angularVelocity.set(0, 0, 0);
  }

  // ===== 物理ステップ（armBody同期の後！）=====
followClawBodies(dt);
  updateClawHitboxVisuals();
const FIXED = 1 / 120;
const MAX_SUB = 8;

world.step(FIXED, dt, MAX_SUB);
  updateBodyDebugMeshes();
  updateContactDebugMarkers();



  // ===== 箱表示同期 =====
  if (boxMesh && boxBody) {
    boxMesh.position.copy(boxBody.position);
    boxMesh.quaternion.copy(boxBody.quaternion);
  }



  renderer.render(scene, camera);
  
}

requestAnimationFrame(animate);
