
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
const ARM_HOLD_SPEED_X = 1; // 横移動速度（1秒あたり）
const ARM_HOLD_SPEED_Z = 1; // 前移動速度（1秒あたり）
const PHYSICS_FIXED_DT = 1 / 120;
const SHOW_PHYSICS_DEBUG = true;
const CONTACT_DEBUG_LIMIT = 80;
// 「持ち上げ成功率」より「ずらし成功率」を優先して調整
const CLAW_BOX_FRICTION = 0.03;
const CLAW_BOX_CONTACT_EQUATION_STIFFNESS = 6.2e4;
const CLAW_BOX_CONTACT_EQUATION_RELAXATION = 10;
const CLAW_BOX_FRICTION_EQUATION_STIFFNESS = 3.2e4;
const CLAW_BOX_FRICTION_EQUATION_RELAXATION = 14;
const BOX_YAW = Math.PI / 2;
const BOX_COM_FRONT_BALLAST_X = -0.08;
const BOX_COM_FRONT_BALLAST_Z = -0.02;
const BOX_COM_FRONT_BALLAST_RADIUS = 0.02;
const BOX_COM_FRONT_BALLAST_MULTIPLIER = 8;
const ENABLE_BOX_ANGULAR_CLAMP = true;
const MAX_BOX_ANGULAR_SPEED_CONTACT = 18.0;
const MAX_BOX_ANGULAR_SPEED_FREE = 30.0;
const SHOW_BOX_INTERNAL_BALLAST_DEBUG = false;
const STICK_VISUAL_POST_ROT = { x: 0, y: Math.PI / 2, z: 0 };
const STICK_BODY_POST_ROT = { x: Math.PI / 2, y: 0, z: Math.PI / 2 };
// 例：到達点（好きに調整）
const ARM_MAX_X = 1.2;   // →でここまで
const ARM_MIN_Z = -1.0;  // ↑(z-)でここまで
// 左右それぞれ別の角度（ラジアン）
const CLAW_L_CLOSED = 0.4;
const CLAW_L_OPEN   = -0.3;






// ===== 爪ヒットボックス：メッシュ頂点からConvexPolyhedronを生成 =====
const BOX_SCALE = 0.7; // 例：1.3倍（小さくするなら 0.8 など）

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
const ARM_DROP_DIST  = 1.0;  // 下げる距離（Y方向）
const ARM_DROP_SPEED = 0.22;   // 下げる速さ（1秒あたり）
const CLAW_CLOSE_TIME = 2.0;  // 閉じるのにかける秒（見た目上の閉じ切り目安）
const CLAW_CLOSE_WAIT_MAX_SEC = 3.0; // 閉じ工程の最短待機秒（この秒数未満では上昇へ移行しない）
const CLAW_FULLY_CLOSED_EPS = 0.02;  // ほぼ閉じ切りとみなす閾値（open01）
const CLAW_CONTACT_HOLD_FRAMES = 4; // 接触判定の瞬断でガタつかないよう保持
const CLAW_CLOSE_DAMP_BOX = 0.18;   // 箱接触中も少しだけ閉じを許可（閉じ切れない問題を軽減）
const CLAW_CLOSE_DAMP_OTHER = 0.22; // 箱以外接触は少しだけ閉じを許可
const CLAW_DROP_PENETRATION_ABORT_SEC = 0.2; // 降下中に刺さり状態が続いたら降下を打ち切って掴みに移る
const CLAW_AUTORETURN_TO_CLOSED = true;
const CLAW_RELEASE_DEBOUNCE_FRAMES = 6;
const CLAW_RETURN_SPEED_OPEN01 = 2.5;
const STEP4_PRESS_RELEASE_OPEN_SPEED = 0.9; // 上昇中の強圧迫時に刺さりを逃がす微小な開き速度
const STEP3_EMBED_GUARD_CONTACT_FRAMES = 5;
const STEP3_EMBED_GUARD_OPEN_SPEED = 0.32; // 両爪で挟んだまま押し込み続けるのを防ぐ

const CLAW_BOX_PRESS_HOLD_FRAMES = 6;
const CLAW_STOP_CLOSE_ON_BOX_PRESS = true;
const CLAW_CLOSE_RELEASE_PULSE = 0.03;
const CLAW_CLOSE_RELEASE_COOLDOWN_FRAMES = 8;
// 箱接触時のみ、重量由来の押し戻しで爪が開き方向に回る（自動開きはしない）
const CLAW_PASSIVE_OPEN_BY_BOX_WEIGHT = true;
// 圧力で開きにくくしたい時の全体つまみ（大きいほど開きにくい）
// 目安: 0.85=開きやすい / 1.0=標準 / 1.15=少し開きにくい / 1.3=かなり開きにくい
const CLAW_PRESSURE_OPEN_HARDNESS = 1.15;
const CLAW_PASSIVE_OPEN_ACCEL_PER_KG = 1.9 / CLAW_PRESSURE_OPEN_HARDNESS;
const CLAW_PASSIVE_OPEN_DAMPING = 8.0;
const CLAW_PASSIVE_OPEN_RESISTANCE = 1.6 * CLAW_PRESSURE_OPEN_HARDNESS;
const CLAW_PASSIVE_OPEN_MAX_SPEED = 0.55;
const CLAW_PASSIVE_OPEN_MIN_BOX_PRESS_FRAMES = 2;
const STEP2_BOX_PRESS_FRAMES_TO_ABORT = 4;
const STEP2_LOCK_ON_BOX_PRESS = true;
const CONTACT_KINEMATIC_MAX_ANGLE_STEP = 0.08;
const FREE_KINEMATIC_MAX_ANGLE_STEP = 0.22;
const CLOSE_STEP_CONTACT_POS_FOLLOW_SCALE = 0.35; // 閉じ工程かつ箱接触中の位置追従は弱めて押し込みを抑える
const CLOSE_STEP_CONTACT_ANGLE_FOLLOW_SCALE = 0.85; // 回転追従は位置より追従させ、見た目と当たり判定のズレを減らす
const CONTACT_VISUAL_MAX_ANGLE_STEP = 0.018; // 接触中の見た目回転の1フレーム上限（rad）
const CLOSE_STEP_CONTACT_VISUAL_SCALE = 0.7; // 閉じ工程の接触時はさらに見た目回転を抑える
const BOX_BASE_LINEAR_DAMPING = 0.08;
const BOX_BASE_ANGULAR_DAMPING = 0.12;
const BOX_CONTACT_LINEAR_DAMPING = 0.30;
const BOX_CONTACT_ANGULAR_DAMPING = 0.36;
const BOX_RELEASE_SETTLE_SECONDS = 0.22;
const BOX_RELEASE_EXTRA_LINEAR_DAMPING = 0.42;
const BOX_RELEASE_MAX_UPWARD_SPEED = 0.05;

const GRIP_CONTACT_DEBOUNCE_FRAMES = 8;
const GRIP_MAX_UPWARD_NORMAL_Y = 0.45;
const GRIP_CENTER_MARGIN = 0.22;
const GRIP_FAIL_TIMEOUT_SEC = 0.8;
const GRIP_RELEASE_PULSE_OPEN01 = 0.08;
const GRIP_RELEASE_PULSE_SEC = 0.14;
const GRIP_DEBUG_LOG_INTERVAL_FRAMES = 20;
const ENABLE_GRIP_DEBUG_LOG = false;
const STEP4_LIFT_ASSIST_SEC = 0.6;
const STEP4_GRIP_LOST_GRACE_SEC = 0.25;

let autoStep = 0;     // 0=待機, 1=開く, 2=下げる, 3=閉じる, 4=上げる, 5=完了
let autoT = 0;
let step3WaitT = 0;
let step3StartOpen01 = 0;
let dropStartY = 0;
let autoStarted = false;
let clawDropPenetrationT = 0;
let boxContactFrames = 0;
let boxReleaseFrames = 9999;
let gripLeftFrames = 0;
let gripRightFrames = 0;
let gripInvalidHoldT = 0;
let gripReleasePulseT = 0;
let gripDebugFrameCounter = 0;
let step4LiftAssistNoContactT = 0;
let step4LiftLatched = false;
let step4GripLostT = 0;
let step4ReleasePulseUsed = false;

let clawBoxPressFramesL = 0;
let clawBoxPressFramesR = 0;
let clawReleasePulseCooldownL = 0;
let clawReleasePulseCooldownR = 0;
let clawPassiveOpenVelL = 0;
let clawPassiveOpenVelR = 0;
let step2BoxPressFrames = 0;
let step2LockYActive = false;
let step2LockY = 0;
let step3EmbedGuardFrames = 0;


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
function getClawContactLevel(body) {
  // 0: 接触なし / 1: 箱以外に接触 / 2: 箱に接触
  if (!body) return 0;

  let level = 0;
  for (const c of world.contacts) {
    if (c.bi !== body && c.bj !== body) continue;

    const other = c.bi === body ? c.bj : c.bi;
    if (!other || other === armBody) continue;
    if (other === boxBody) return 2;
    level = Math.max(level, 1);
  }

  return level;
}

function collectClawBoxContactStats() {
  let normalYSum = 0;
  let contactCount = 0;

  for (const c of world.contacts) {
    const bi = c.bi;
    const bj = c.bj;
    const isClawBoxPair =
      ((bi === clawLBody || bi === clawRBody) && bj === boxBody) ||
      ((bj === clawLBody || bj === clawRBody) && bi === boxBody);

    if (!isClawBoxPair) continue;

    // c.ni は bi->bj。箱側法線Yをそろえて平均する
    const normalTowardBoxY = bj === boxBody ? c.ni.y : -c.ni.y;
    normalYSum += normalTowardBoxY;
    contactCount += 1;
  }

  const avgNormalY = contactCount > 0 ? normalYSum / contactCount : 0;
  return { avgNormalY, contactCount };
}

function isBoxCenterBetweenClaws(margin = GRIP_CENTER_MARGIN) {
  if (!boxBody || !clawLBody || !clawRBody) return false;

  const l = clawLBody.position;
  const r = clawRBody.position;
  const b = boxBody.position;

  const axis = r.vsub(l);
  const len = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
  if (len < 1e-6) return false;

  const nx = axis.x / len;
  const ny = axis.y / len;
  const nz = axis.z / len;

  const relx = b.x - l.x;
  const rely = b.y - l.y;
  const relz = b.z - l.z;
  const t = relx * nx + rely * ny + relz * nz; // L->R への射影

  return t >= -margin && t <= len + margin;
}

function getValidGripStatus() {
  const touchingLeftBox = getClawContactLevel(clawLBody) === 2;
  const touchingRightBox = getClawContactLevel(clawRBody) === 2;

  gripLeftFrames = touchingLeftBox ? gripLeftFrames + 1 : 0;
  gripRightFrames = touchingRightBox ? gripRightFrames + 1 : 0;

  const contactStats = collectClawBoxContactStats();
  const centerBetween = isBoxCenterBetweenClaws();
  const twoSideStable = gripLeftFrames >= GRIP_CONTACT_DEBOUNCE_FRAMES && gripRightFrames >= GRIP_CONTACT_DEBOUNCE_FRAMES;
  const noJackUpPush = contactStats.avgNormalY < GRIP_MAX_UPWARD_NORMAL_Y;

  const validGrip = twoSideStable && noJackUpPush && centerBetween;

  return {
    validGrip,
    avgNormalY: contactStats.avgNormalY,
    leftFrames: gripLeftFrames,
    rightFrames: gripRightFrames,
    centerBetween,
  };
}

function softenClosingDelta(delta, isClosingPositive, damp) {
  // 閉じ方向の成分だけを減衰し、開き方向はそのまま通す
  const closingPart = isClosingPositive ? Math.max(delta, 0) : Math.min(delta, 0);
  const openingPart = delta - closingPart;
  return openingPart + closingPart * damp;
}

function limitAngleStep(current, target, maxStep) {
  if (!Number.isFinite(maxStep) || maxStep <= 0) return target;
  const delta = target - current;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

function angleToOpen01(angle, closed, open) {
  return THREE.MathUtils.clamp(
    THREE.MathUtils.inverseLerp(closed, open, angle),
    0,
    1,
  );
}

function getClawPivotAngle(pivot, fallbackAngle) {
  if (!pivot) return fallbackAngle;
  return pivot.rotation[CLAW_AXIS] * CLAW_SIGN;
}

function setClawPivotAngle(pivot, logicalAngle) {
  if (!pivot) return;
  pivot.rotation[CLAW_AXIS] = logicalAngle * CLAW_SIGN;
}

let clawContactHoldL = 0;
let clawContactHoldR = 0;

function applyPassiveOpenByBoxWeight(currentAngle, level, closedAngle, openAngle, currentVel, dt, boxPressFrames) {
  const passiveActive =
    CLAW_PASSIVE_OPEN_BY_BOX_WEIGHT &&
    autoStarted &&
    autoStep === 3 &&
    boxBody &&
    level === 2 &&
    boxPressFrames >= CLAW_PASSIVE_OPEN_MIN_BOX_PRESS_FRAMES;

  if (!passiveActive) {
    const dampedVel = currentVel * Math.exp(-CLAW_PASSIVE_OPEN_DAMPING * dt);
    return {
      nextAngle: currentAngle,
      nextVel: Math.abs(dampedVel) < 1e-4 ? 0 : dampedVel,
    };
  }

  const openDir = Math.sign(openAngle - closedAngle) || 1;
  const accel = (boxBody.mass * CLAW_PASSIVE_OPEN_ACCEL_PER_KG / CLAW_PASSIVE_OPEN_RESISTANCE) * openDir;
  let nextVel = (currentVel + accel * dt) * Math.exp(-CLAW_PASSIVE_OPEN_DAMPING * dt);
  nextVel = THREE.MathUtils.clamp(nextVel, -CLAW_PASSIVE_OPEN_MAX_SPEED, CLAW_PASSIVE_OPEN_MAX_SPEED);

  return {
    nextAngle: currentAngle + nextVel * dt,
    nextVel,
  };
}

function setClawOpen01(open01, dt = 1 / 60) {
  // 0=閉, 1=開
  const nextOpen01 = THREE.MathUtils.clamp(open01, 0, 1);
  const prevOpen01 = clawOpen01;
  const isClosing = nextOpen01 < prevOpen01;

  const targetL = THREE.MathUtils.lerp(CLAW_L_CLOSED, CLAW_L_OPEN, nextOpen01);
  const targetR = THREE.MathUtils.lerp(CLAW_R_CLOSED, CLAW_R_OPEN, nextOpen01);

  const currentL = getClawPivotAngle(clawLPivot, targetL);
  const currentR = getClawPivotAngle(clawRPivot, targetR);

  const levelL = getClawContactLevel(clawLBody);
  const levelR = getClawContactLevel(clawRBody);

  // 接触判定の瞬断で「圧迫フレーム」が途切れないよう減衰方式にする
  clawBoxPressFramesL = levelL === 2 ? clawBoxPressFramesL + 1 : Math.max(0, clawBoxPressFramesL - 1);
  clawBoxPressFramesR = levelR === 2 ? clawBoxPressFramesR + 1 : Math.max(0, clawBoxPressFramesR - 1);
  clawReleasePulseCooldownL = Math.max(0, clawReleasePulseCooldownL - 1);
  clawReleasePulseCooldownR = Math.max(0, clawReleasePulseCooldownR - 1);

  if (levelL !== 2) clawReleasePulseCooldownL = 0;
  if (levelR !== 2) clawReleasePulseCooldownR = 0;

  clawContactHoldL = levelL === 2 ? CLAW_CONTACT_HOLD_FRAMES : Math.max(0, clawContactHoldL - 1);
  clawContactHoldR = levelR === 2 ? CLAW_CONTACT_HOLD_FRAMES : Math.max(0, clawContactHoldR - 1);

  let nextL = targetL;
  let nextR = targetR;

  if (isClosing && clawContactHoldL > 0) {
    const dampL = levelL === 2 ? CLAW_CLOSE_DAMP_BOX : CLAW_CLOSE_DAMP_OTHER;
    nextL = currentL + softenClosingDelta(targetL - currentL, true, dampL);

    // 箱への押し込み継続を防ぐ：箱接触が続いたら閉じ停止+微小に開き戻す
    if (
      levelL === 2 &&
      clawBoxPressFramesL >= CLAW_BOX_PRESS_HOLD_FRAMES
    ) {
      if (CLAW_STOP_CLOSE_ON_BOX_PRESS) {
        // 圧迫状態が続く間は閉じ方向の回転を止める
        nextL = currentL;
      } else if (clawReleasePulseCooldownL === 0) {
        nextL = currentL - CLAW_CLOSE_RELEASE_PULSE;
        clawReleasePulseCooldownL = CLAW_CLOSE_RELEASE_COOLDOWN_FRAMES;
      }
    }
  }
  if (isClosing && clawContactHoldR > 0) {
    const dampR = levelR === 2 ? CLAW_CLOSE_DAMP_BOX : CLAW_CLOSE_DAMP_OTHER;
    nextR = currentR + softenClosingDelta(targetR - currentR, false, dampR);

    // 箱への押し込み継続を防ぐ：箱接触が続いたら閉じ停止+微小に開き戻す
    if (
      levelR === 2 &&
      clawBoxPressFramesR >= CLAW_BOX_PRESS_HOLD_FRAMES
    ) {
      if (CLAW_STOP_CLOSE_ON_BOX_PRESS) {
        // 圧迫状態が続く間は閉じ方向の回転を止める
        nextR = currentR;
      } else if (clawReleasePulseCooldownR === 0) {
        nextR = currentR + CLAW_CLOSE_RELEASE_PULSE;
        clawReleasePulseCooldownR = CLAW_CLOSE_RELEASE_COOLDOWN_FRAMES;
      }
    }
  }

  if (isClosing) {
    const passiveL = applyPassiveOpenByBoxWeight(nextL, levelL, CLAW_L_CLOSED, CLAW_L_OPEN, clawPassiveOpenVelL, dt, clawBoxPressFramesL);
    nextL = passiveL.nextAngle;
    clawPassiveOpenVelL = passiveL.nextVel;

    const passiveR = applyPassiveOpenByBoxWeight(nextR, levelR, CLAW_R_CLOSED, CLAW_R_OPEN, clawPassiveOpenVelR, dt, clawBoxPressFramesR);
    nextR = passiveR.nextAngle;
    clawPassiveOpenVelR = passiveR.nextVel;
  } else {
    clawPassiveOpenVelL *= Math.exp(-CLAW_PASSIVE_OPEN_DAMPING * dt);
    clawPassiveOpenVelR *= Math.exp(-CLAW_PASSIVE_OPEN_DAMPING * dt);
  }

  const visualScaleL = (levelL === 2 && autoStarted && autoStep === 3) ? CLOSE_STEP_CONTACT_VISUAL_SCALE : 1.0;
  const visualScaleR = (levelR === 2 && autoStarted && autoStep === 3) ? CLOSE_STEP_CONTACT_VISUAL_SCALE : 1.0;
  const maxVisualStepL = levelL === 2 ? CONTACT_VISUAL_MAX_ANGLE_STEP * visualScaleL : Infinity;
  const maxVisualStepR = levelR === 2 ? CONTACT_VISUAL_MAX_ANGLE_STEP * visualScaleR : Infinity;
  nextL = limitAngleStep(currentL, nextL, maxVisualStepL);
  nextR = limitAngleStep(currentR, nextR, maxVisualStepR);

  const minL = Math.min(CLAW_L_CLOSED, CLAW_L_OPEN);
  const maxL = Math.max(CLAW_L_CLOSED, CLAW_L_OPEN);
  const minR = Math.min(CLAW_R_CLOSED, CLAW_R_OPEN);
  const maxR = Math.max(CLAW_R_CLOSED, CLAW_R_OPEN);
  nextL = THREE.MathUtils.clamp(nextL, minL, maxL);
  nextR = THREE.MathUtils.clamp(nextR, minR, maxR);

  setClawPivotAngle(clawLPivot, nextL);
  setClawPivotAngle(clawRPivot, nextR);

  const openL01 = angleToOpen01(nextL, CLAW_L_CLOSED, CLAW_L_OPEN);
  const openR01 = angleToOpen01(nextR, CLAW_R_CLOSED, CLAW_R_OPEN);
  clawOpen01L = openL01;
  clawOpen01R = openR01;
  // コマンド値は入力(open01)を保持する。
  // 圧力で片側だけ受動的に開いても、もう片側へ同期しないようにする。
  clawOpen01 = nextOpen01;
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
const matCrane = new CANNON.Material("crane");

world.solver.iterations = 20;
world.solver.tolerance = 0.001;

world.addContactMaterial(
  new CANNON.ContactMaterial(matStick, matBox, {
    friction: 0.12,
    restitution: 0.0,
  })
);

world.addContactMaterial(
  new CANNON.ContactMaterial(matClaw, matBox, {
    friction: CLAW_BOX_FRICTION,
    restitution: 0.0,
    contactEquationStiffness: CLAW_BOX_CONTACT_EQUATION_STIFFNESS,
    contactEquationRelaxation: CLAW_BOX_CONTACT_EQUATION_RELAXATION,
    frictionEquationStiffness: CLAW_BOX_FRICTION_EQUATION_STIFFNESS,
    frictionEquationRelaxation: CLAW_BOX_FRICTION_EQUATION_RELAXATION,
  })
);

world.addContactMaterial(
  new CANNON.ContactMaterial(matCrane, matBox, {
    friction: 0.28,
    restitution: 0.0,
  })
);


const loader = new GLTFLoader();

let boxMesh, stick1Mesh, stick2Mesh, craneMesh;
let boxBody, stick1Body, stick2Body;
let stick3Mesh, stick4Mesh;
let stick3Body, stick4Body;
let craneBody;

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
  clawDropPenetrationT = 0;
  gripLeftFrames = 0;
  gripRightFrames = 0;
  gripInvalidHoldT = 0;
  gripReleasePulseT = 0;

  step2BoxPressFrames = 0;
  step2LockYActive = false;

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
let boxComDebugMesh = null;

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

    // 箱の内部バラスト球は重心調整用で、見た目上は重心マーカーと紛らわしいため通常は非表示
    if (!SHOW_BOX_INTERNAL_BALLAST_DEBUG && body === boxBody && shape instanceof CANNON.Sphere) {
      continue;
    }

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
    } else if (shape instanceof CANNON.Sphere) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(shape.radius, 12, 12),
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

function getConvexVolume(shape) {
  if (!(shape instanceof CANNON.ConvexPolyhedron)) return 0;

  let vol6 = 0;
  for (const face of shape.faces) {
    if (!face || face.length < 3) continue;
    const i0 = face[0];
    for (let i = 1; i < face.length - 1; i++) {
      const ia = face[i];
      const ib = face[i + 1];
      const a = shape.vertices[i0];
      const b = shape.vertices[ia];
      const c = shape.vertices[ib];
      // det(a,b,c) = a・(b×c)
      vol6 += a.x * (b.y * c.z - b.z * c.y)
            - a.y * (b.x * c.z - b.z * c.x)
            + a.z * (b.x * c.y - b.y * c.x);
    }
  }

  return Math.abs(vol6) / 6;
}

function getShapeMassWeight(shape) {
  if (shape instanceof CANNON.Box) {
    const h = shape.halfExtents;
    return Math.max(8 * h.x * h.y * h.z, 1e-6);
  }
  if (shape instanceof CANNON.Sphere) {
    return Math.max((4 / 3) * Math.PI * shape.radius * shape.radius * shape.radius, 1e-6);
  }
  if (shape instanceof CANNON.Cylinder) {
    return Math.max(Math.PI * shape.radiusTop * shape.radiusBottom * shape.height, 1e-6);
  }
  if (shape instanceof CANNON.ConvexPolyhedron) {
    // boundingSphere近似だと重心シフトが効きにくいので、面から体積を近似算出
    return Math.max(getConvexVolume(shape), 1e-6);
  }
  return 1;
}

function computeBodyLocalCenterOfMassApprox(body) {
  const com = new CANNON.Vec3(0, 0, 0);
  if (!body || !body.shapes.length) return com;

  let totalWeight = 0;
  for (let i = 0; i < body.shapes.length; i++) {
    const w = getShapeMassWeight(body.shapes[i]);
    const off = body.shapeOffsets[i];
    com.x += off.x * w;
    com.y += off.y * w;
    com.z += off.z * w;
    totalWeight += w;
  }

  if (totalWeight <= 1e-6) return com;
  com.scale(1 / totalWeight, com);
  return com;
}

function ensureBoxComDebugMesh() {
  if (!SHOW_PHYSICS_DEBUG || boxComDebugMesh) return;

  boxComDebugMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
    })
  );
  // 箱の向こう側にあっても必ず見えるように最前面描画
  boxComDebugMesh.renderOrder = 20000;
  scene.add(boxComDebugMesh);
}

function updateBoxCenterOfMassDebug() {
  if (!SHOW_PHYSICS_DEBUG || !boxComDebugMesh || !boxBody) return;

  const localCom = computeBodyLocalCenterOfMassApprox(boxBody);
  const worldCom = new CANNON.Vec3();

  // pointToWorldFrame 依存を避け、位置+姿勢から明示的に重心座標を算出
  boxBody.quaternion.vmult(localCom, worldCom);
  worldCom.vadd(boxBody.position, worldCom);

  boxComDebugMesh.position.set(worldCom.x, worldCom.y, worldCom.z);

  // サイズは固定（見た目の違和感を減らす）
  boxComDebugMesh.scale.setScalar(1);
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
  // 重心マーカー（球）と見分けやすいよう、ヒンジ位置は立方体マーカーで表示
  const geo = new THREE.BoxGeometry(size * 1.4, size * 1.4, size * 1.4);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
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
syncKinematicBodiesToVisualNow();


  // ===== クレーン台（見た目だけ）=====
  craneMesh = craneGltf.scene;
  craneMesh.scale.setScalar(WORLD_SCALE);
  centerToOriginAndGround(craneMesh);
  craneMesh.position.y -= 2;
  scene.add(craneMesh);

  // ===== 物理：クレーン本体（静的・形状自動）=====
  craneMesh.updateMatrixWorld(true);
  craneBody = new CANNON.Body({ mass: 0, material: matCrane });
  const craneShapes = computeConvexShapesFromRoot(craneMesh);

  if (craneShapes.length) {
    for (const shapeDef of craneShapes) {
      craneBody.addShape(shapeDef.shape, shapeDef.offset, shapeDef.orient);
    }
  } else {
    const craneSize = getBoxSize(craneMesh);
    craneBody.addShape(new CANNON.Box(new CANNON.Vec3(
      Math.max(craneSize.x / 2, 0.01),
      Math.max(craneSize.y / 2, 0.01),
      Math.max(craneSize.z / 2, 0.01)
    )));
  }

  craneBody.position.copy(craneMesh.position);
  craneBody.quaternion.copy(craneMesh.quaternion);
  world.addBody(craneBody);
  addBodyDebugMeshes(craneBody, 0x00ff66);

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

// 見た目はY軸90°、物理は既存設定のまま別々に適用する（同期なし）
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
    linearDamping: BOX_BASE_LINEAR_DAMPING,
    angularDamping: BOX_BASE_ANGULAR_DAMPING,
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
      // 箱の外形コリジョンは見た目と一致させる（offsetは変更しない）
      boxBody.addShape(shapeDef.shape, shapeDef.offset, shapeDef.orient);
    }
  } else {
    const boxHalf = new CANNON.Vec3(
      Math.max(boxSize.x / 2, 0.01),
      Math.max(boxSize.y / 2, 0.01),
      Math.max(boxSize.z / 2, 0.01)
    );
    // 単純Boxフォールバック時も同じく前寄り重心にする
    boxBody.addShape(new CANNON.Box(boxHalf), new CANNON.Vec3(0, 0, -BOX_CENTER_OF_MASS_FRONT_SHIFT_Z));
  }

  // 見た目とのズレを出さず、重心だけ前寄りへ寄せる内部バラスト
  // ※重複追加バグを防ぐため、この関数呼び出し1箇所に集約する
  addFrontBallastShapes(boxBody);

  // shape追加後に質量・慣性を必ず再計算（重心反映を確実化）
  boxBody.updateMassProperties();
  boxBody.updateBoundingRadius();
  boxBody.aabbNeedsUpdate = true;

  boxBody.position.copy(boxMesh.position);
  boxBody.quaternion.copy(boxMesh.quaternion);
  world.addBody(boxBody);
  addBodyDebugMeshes(boxBody, 0x00ffff);
  ensureBoxComDebugMesh();

  boxMesh.position.copy(boxBody.position);

  camera.lookAt(0, 0.4, 0);
}
let clawOpen01 = 0;  // 両爪へ与える開閉コマンド値（0=閉, 1=開）
let clawOpen01L = 0; // 左爪の実開度（0=閉, 1=開）
let clawOpen01R = 0; // 右爪の実開度（0=閉, 1=開）

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


function addFrontBallastShapes(body) {
  if (!body) return;

  for (let i = 0; i < BOX_COM_FRONT_BALLAST_MULTIPLIER; i++) {
    body.addShape(
      new CANNON.Sphere(BOX_COM_FRONT_BALLAST_RADIUS),
      new CANNON.Vec3(BOX_COM_FRONT_BALLAST_X, 0, BOX_COM_FRONT_BALLAST_Z)
    );
  }
}

loadScene().catch(console.error);

let lastT;
const clawL_local = new CANNON.Vec3(0, -0.25,  0.12);
const clawR_local = new CANNON.Vec3(0, -0.25, -0.12);





const MAX_KINEMATIC_SPEED = 0.8;
const CONTACT_KINEMATIC_SPEED = 0.24;
const MAX_BOX_LINEAR_SPEED = 12.0;
let boxReleaseSettleTimer = 0;
let wasClawContactLastFrame = false;

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

function clampBodyAngularVelocity(body, maxSpeed) {
  const wx = body.angularVelocity.x;
  const wy = body.angularVelocity.y;
  const wz = body.angularVelocity.z;
  const speedSq = wx * wx + wy * wy + wz * wz;
  const maxSq = maxSpeed * maxSpeed;
  if (speedSq <= maxSq) return;

  const scale = maxSpeed / Math.sqrt(speedSq);
  body.angularVelocity.set(wx * scale, wy * scale, wz * scale);
}

function stabilizePrizeBody(body) {
  if (!body) return;

  const clawContact = getClawContactLevel(clawLBody) > 0 || getClawContactLevel(clawRBody) > 0;

  if (!clawContact && wasClawContactLastFrame) {
    boxReleaseSettleTimer = BOX_RELEASE_SETTLE_SECONDS;
  }
  wasClawContactLastFrame = clawContact;

  if (boxReleaseSettleTimer > 0) {
    boxReleaseSettleTimer = Math.max(0, boxReleaseSettleTimer - PHYSICS_FIXED_DT);
  }

  // 接触中は箱側をソフトに減衰させてsolver破綻（潰れ/飛び）を抑える
  body.linearDamping = clawContact ? BOX_CONTACT_LINEAR_DAMPING : BOX_BASE_LINEAR_DAMPING;
  body.angularDamping = clawContact ? BOX_CONTACT_ANGULAR_DAMPING : BOX_BASE_ANGULAR_DAMPING;

  // 爪から離れた直後にだけ減衰を強め、上方向の跳ね返りを抑える
  if (boxReleaseSettleTimer > 0) {
    body.linearDamping = Math.max(body.linearDamping, BOX_RELEASE_EXTRA_LINEAR_DAMPING);
    if (body.velocity.y > BOX_RELEASE_MAX_UPWARD_SPEED) {
      body.velocity.y = BOX_RELEASE_MAX_UPWARD_SPEED;
    }
  }


  clampBodyLinearVelocity(body, MAX_BOX_LINEAR_SPEED);

  // 常時ガチガチに角速度を止めるとピッチが出にくいので、接触時のみやや緩く制限
  if (ENABLE_BOX_ANGULAR_CLAMP) {

    

    const maxAngular = isClawPressingSomething() ? MAX_BOX_ANGULAR_SPEED_CONTACT : MAX_BOX_ANGULAR_SPEED_FREE;

    clampBodyAngularVelocity(body, maxAngular);
  }
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

function isClawPressingBox() {
  if (!clawLBody || !clawRBody || !boxBody) return false;

  for (const c of world.contacts) {
    const bi = c.bi;
    const bj = c.bj;
    const isClawBox =
      ((bi === clawLBody || bi === clawRBody) && bj === boxBody) ||
      ((bj === clawLBody || bj === clawRBody) && bi === boxBody);
    if (isClawBox) return true;
  }
  return false;
}

function moveKinematicBodyTowardMesh(body, mesh, prevPos, dt, isContact) {
  if (!body || !mesh) return;

  mesh.updateWorldMatrix(true, false);
  const desiredPos3 = new THREE.Vector3();
  const desiredQuat3 = new THREE.Quaternion();
  mesh.getWorldPosition(desiredPos3);
  mesh.getWorldQuaternion(desiredQuat3);

  const desiredPos = threeVecToCannon(desiredPos3);

  const inCloseContact = isContact && autoStarted && autoStep === 3;
  const posFollowScale = inCloseContact ? CLOSE_STEP_CONTACT_POS_FOLLOW_SCALE : 1.0;
  const angleFollowScale = inCloseContact ? CLOSE_STEP_CONTACT_ANGLE_FOLLOW_SCALE : 1.0;
  const maxMove = Math.max((isContact ? CONTACT_KINEMATIC_SPEED : MAX_KINEMATIC_SPEED) * posFollowScale * dt, 0);
  const dx = desiredPos.x - prevPos.x;
  const dy = desiredPos.y - prevPos.y;
  const dz = desiredPos.z - prevPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const moveScale = dist > 1e-8 ? Math.min(1, maxMove / dist) : 1;

  body.position.set(
    prevPos.x + dx * moveScale,
    prevPos.y + dy * moveScale,
    prevPos.z + dz * moveScale
  );

  // 接触中は回転追従量も制限して、めり込み起点の過大トルクを抑える
  const currentQ3 = cannonQuatToThree(body.quaternion);
  const dot = Math.min(1, Math.max(-1, Math.abs(currentQ3.dot(desiredQuat3))));
  const angle = 2 * Math.acos(dot);
  const maxAngleBase = isContact ? CONTACT_KINEMATIC_MAX_ANGLE_STEP : FREE_KINEMATIC_MAX_ANGLE_STEP;
  const maxAngle = maxAngleBase * angleFollowScale;
  const t = angle > 1e-6 ? Math.min(1, maxAngle / angle) : 1;
  currentQ3.slerp(desiredQuat3, t);
  body.quaternion.copy(threeQuatToCannon(currentQ3));
}

function followClawBodies(dt) {
  if (!armBody || !clawLBody || !clawRBody) return;
  if (!armGroup || !clawLMesh || !clawRMesh) return;

  // armBody は armGroup に同期（animate側でやっている）

  // 速度計算用（前フレームの位置を保存）
  prevClawL.copy(clawLBody.position);
  prevClawR.copy(clawRBody.position);

  // 棒など「箱以外」の接触で追従を過剰に遅くすると
  // 閉じモーションが止まって見えるため、速度制限は箱接触時のみ有効化する。
  const leftContact = getClawContactLevel(clawLBody) === 2;
  const rightContact = getClawContactLevel(clawRBody) === 2;

  // 接触中はテレポート同期せず、1stepあたりの追従量を制限して押し込みを防ぐ
  moveKinematicBodyTowardMesh(clawLBody, clawLMesh, prevClawL, dt, leftContact);
  moveKinematicBodyTowardMesh(clawRBody, clawRMesh, prevClawR, dt, rightContact);

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
  }
  clawLBody.angularVelocity.set(0, 0, 0);
  clawRBody.angularVelocity.set(0, 0, 0);
}

function syncKinematicBodiesToVisualNow() {
  if (!armGroup || !armBody) return;

  armGroup.updateWorldMatrix(true, true);
  armBody.position.set(armGroup.position.x, armGroup.position.y, armGroup.position.z);
  armBody.quaternion.set(
    armGroup.quaternion.x,
    armGroup.quaternion.y,
    armGroup.quaternion.z,
    armGroup.quaternion.w
  );
  armBody.velocity.set(0, 0, 0);
  armBody.angularVelocity.set(0, 0, 0);

  if (clawLBody && clawLMesh) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    clawLMesh.getWorldPosition(pos);
    clawLMesh.getWorldQuaternion(quat);
    clawLBody.position.set(pos.x, pos.y, pos.z);
    clawLBody.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    clawLBody.velocity.set(0, 0, 0);
    clawLBody.angularVelocity.set(0, 0, 0);
  }

  if (clawRBody && clawRMesh) {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    clawRMesh.getWorldPosition(pos);
    clawRMesh.getWorldQuaternion(quat);
    clawRBody.position.set(pos.x, pos.y, pos.z);
    clawRBody.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    clawRBody.velocity.set(0, 0, 0);
    clawRBody.angularVelocity.set(0, 0, 0);
  }
}

function animate(t) {
  requestAnimationFrame(animate);

  if (lastT == null) lastT = t;
  const dt = Math.min((t - lastT) / 1000, 1 / 30);

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

  const gripStatus = getValidGripStatus();
  if (ENABLE_GRIP_DEBUG_LOG) {
    gripDebugFrameCounter += 1;
    if (gripDebugFrameCounter % GRIP_DEBUG_LOG_INTERVAL_FRAMES === 0) {
      console.log(
        `[Grip] valid=${gripStatus.validGrip} L=${gripStatus.leftFrames} R=${gripStatus.rightFrames} avgNy=${gripStatus.avgNormalY.toFixed(3)} center=${gripStatus.centerBetween}`
      );
    }
  }

  // ===== 自動シーケンス（Three側）=====
  // ステップ: 1=開く → 2=下げる → 3=閉じる → 4=上げる → 5=完了
if (autoStarted) {
  if (autoStep === 1) {
    // ===== ステップ1: 爪を開く =====
    autoT += dt;
    setClawOpen01(Math.min(autoT / CLAW_OPEN_TIME, 1), dt);
    if (autoT >= CLAW_OPEN_TIME) { autoStep = 2; autoT = 0; dropStartY = armGroup.position.y; clawDropPenetrationT = 0; }

  } else if (autoStep === 2) {
    // ===== ステップ2: アームを下げる =====
    const targetY = dropStartY - ARM_DROP_DIST;
    const pressing = isClawPressingSomething();
    const boxPressing = getClawContactLevel(clawLBody) === 2 || getClawContactLevel(clawRBody) === 2;
    const dropSpeed = pressing ? ARM_DROP_SPEED * 0.25 : ARM_DROP_SPEED;

    const finishDropStep = () => {
      // 降下完了後は必ず一定時間だけ閉じ工程を実行してから上昇する。
      autoStep = 3;
      autoT = 0;
      step3WaitT = 0;
      step3StartOpen01 = clawOpen01;
      clawDropPenetrationT = 0;
      step2BoxPressFrames = 0;
      step2LockYActive = false;
      step3EmbedGuardFrames = 0;
    };

    if (boxPressing) {
      step2BoxPressFrames += 1;
      if (STEP2_LOCK_ON_BOX_PRESS && !step2LockYActive) {
        step2LockYActive = true;
        step2LockY = armGroup.position.y;
      }
    } else {
      step2BoxPressFrames = 0;
    }

    if (step2LockYActive) {
      // 箱接触後はそれ以上押し込まない
      armGroup.position.y = Math.max(targetY, step2LockY);
    } else {
      armGroup.position.y = Math.max(targetY, armGroup.position.y - dropSpeed * dt);
    }

    // 降下中に「刺さり状態」が続いたら、これ以上押し込まず掴み工程へ移行
    if (boxPressing && pressing) clawDropPenetrationT += dt;
    else clawDropPenetrationT = 0;

    if (clawDropPenetrationT >= CLAW_DROP_PENETRATION_ABORT_SEC || step2BoxPressFrames >= STEP2_BOX_PRESS_FRAMES_TO_ABORT) {
      finishDropStep();
    } else if (armGroup.position.y <= targetY + 1e-6) {
      finishDropStep();
    }

  } else if (autoStep === 3) {
    // ===== ステップ3: 爪を閉じる =====
    autoT += dt;
    const bothClawsPressingBox =
      getClawContactLevel(clawLBody) === 2 &&
      getClawContactLevel(clawRBody) === 2 &&
      clawBoxPressFramesL >= CLAW_BOX_PRESS_HOLD_FRAMES &&
      clawBoxPressFramesR >= CLAW_BOX_PRESS_HOLD_FRAMES;
    step3EmbedGuardFrames = bothClawsPressingBox ? step3EmbedGuardFrames + 1 : 0;

    // 閉じコマンドは elapsed time から直接計算する。
    // これにより接触状態や前フレーム値に引きずられず、常に時間制で進行する。
    const closeT = THREE.MathUtils.clamp(autoT / CLAW_CLOSE_TIME, 0, 1);
    const closeCmdOpen01 = THREE.MathUtils.lerp(step3StartOpen01, 0, closeT);

    // 両爪で箱を挟んだ状態が続くなら、さらに閉じて押し込まず少し開いて逃がす。
    if (step3EmbedGuardFrames >= STEP3_EMBED_GUARD_CONTACT_FRAMES) {
      setClawOpen01(clawOpen01 + STEP3_EMBED_GUARD_OPEN_SPEED * dt, dt);
    } else {
      setClawOpen01(closeCmdOpen01, dt);
    }

    // ステップ3は最低でも CLAW_CLOSE_WAIT_MAX_SEC 秒は維持する。
    // 圧迫解除後の追い閉じはステップ4（上昇中）で継続する。
    if (autoT >= CLAW_CLOSE_WAIT_MAX_SEC) {
      autoStep = 4;
      autoT = 0;
      step4LiftAssistNoContactT = 0;
      step4LiftLatched = false;
      step4GripLostT = 0;
      step4ReleasePulseUsed = false;
    }


  } else if (autoStep === 4) {
    // ===== ステップ4: アームを元の高さまで上げる =====
    autoT += dt;
    const targetY = dropStartY;

    // 持ち上げ中も、箱を強く圧迫していない間は閉じ方向の駆動を継続する。
    // これにより、圧迫で閉じ切れなかった場合でも、上昇中に解放されれば追従して閉じる。
    const liftingBoxPressing =
      (getClawContactLevel(clawLBody) === 2 && clawBoxPressFramesL >= CLAW_BOX_PRESS_HOLD_FRAMES) ||
      (getClawContactLevel(clawRBody) === 2 && clawBoxPressFramesR >= CLAW_BOX_PRESS_HOLD_FRAMES);
    if (liftingBoxPressing) {
      // 刺さり状態で上昇を止めないため、圧迫中は一旦わずかに開いて食い込みを逃がす。
      setClawOpen01(clawOpen01 + STEP4_PRESS_RELEASE_OPEN_SPEED * dt, dt);
    } else if (clawOpen01 > 0) {
      setClawOpen01(clawOpen01 - (dt / CLAW_CLOSE_TIME), dt);
    }

    // 上昇は常に実行する。掴み判定に依存すると
    // 条件が揃わないケースでステップ4が停止してしまうため。
    armGroup.position.y = Math.min(targetY, armGroup.position.y + ARM_RISE_SPEED * dt);

    if (armGroup.position.y >= targetY - 1e-6) {
      armGroup.position.y = targetY;
      autoStep = 5;
    }

  } else if (autoStep === 5) {
    // ===== ステップ5: 完了 =====
    // 完了時は爪を閉じ方向へ戻す（接触状態に依存せず確実に閉める）
    if (clawOpen01 > 0) {
      const nextOpen01 = Math.max(0, clawOpen01 - CLAW_RETURN_SPEED_OPEN01 * dt);
      setClawOpen01(nextOpen01, dt);
    }
  }
}

  // 箱接触が切れたあと、一定フレームで爪を完全クローズへ戻す（瞬断対策つき）
  const boxTouchingNow = getClawContactLevel(clawLBody) === 2 || getClawContactLevel(clawRBody) === 2;
  if (boxTouchingNow) {
    boxContactFrames += 1;
    boxReleaseFrames = 0;
  } else {
    boxReleaseFrames += 1;
  }

  const autoSequenceBusy = autoStarted && autoStep > 0 && autoStep < 5;
  if (
    CLAW_AUTORETURN_TO_CLOSED &&
    !autoSequenceBusy &&
    boxReleaseFrames >= CLAW_RELEASE_DEBOUNCE_FRAMES &&
    clawOpen01 > 0
  ) {
    const nextOpen01 = Math.max(0, clawOpen01 - CLAW_RETURN_SPEED_OPEN01 * dt);
    setClawOpen01(nextOpen01, dt);
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
const MAX_SUB = 8;

world.step(PHYSICS_FIXED_DT, dt, MAX_SUB);
  stabilizePrizeBody(boxBody);
  updateBodyDebugMeshes();
  updateContactDebugMarkers();
  updateBoxCenterOfMassDebug();



  // ===== 箱表示同期 =====
  if (boxMesh && boxBody) {
    boxMesh.position.copy(boxBody.position);
    boxMesh.quaternion.copy(boxBody.quaternion);
  }



  renderer.render(scene, camera);
  
}

requestAnimationFrame(animate);
