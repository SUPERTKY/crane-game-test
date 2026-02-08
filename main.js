import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const WORLD_SCALE = 0.25;
const ARM_SCALE = 2; // ←ここを 1.2〜2.0 で調整


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
world.allowSleep = true;

const matStick = new CANNON.Material("stick");
const matBox = new CANNON.Material("box");

world.addContactMaterial(
  new CANNON.ContactMaterial(matStick, matBox, {
    friction: 0.05,
    restitution: 0.0,
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

  // ★背景・枠・影を全部消す
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

  const img = document.createElement("img");
  img.src = "./assets/Arrow.png";
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.transform = `rotate(${rotationDeg}deg)`;
  img.style.pointerEvents = "none";

  btn.appendChild(img);

  // ボタンとしては機能（まだ何も処理しない）
  btn.addEventListener("click", () => {
    console.log("Arrow clicked", rotationDeg);
  });

  return btn;
}

const arrowBtn1 = makeArrowButton(0);    // →（そのまま）
const arrowBtn2 = makeArrowButton(90);   // ↑（90度回転）

arrowUI.appendChild(arrowBtn1);
arrowUI.appendChild(arrowBtn2);

/**
 * 棒の当たり判定：
 * - 見た目(回転後)のAABBサイズから「一番長い軸」を長手として採用
 * - それ以外2軸を thicknessRatio 倍に細くする
 */
function makeStickHalfExtentsFromMesh(stickMesh, thicknessRatio = 0.04) {
  // ★回転/スケール/移動を反映させた状態でBox3を取る
  stickMesh.updateWorldMatrix(true, true);

  const s = getBoxSize(stickMesh);

  const axes = [
    { k: "x", v: s.x },
    { k: "y", v: s.y },
    { k: "z", v: s.z },
  ].sort((a, b) => b.v - a.v);

  const longAxis = axes[0].k;

  const half = { x: s.x / 2, y: s.y / 2, z: s.z / 2 };
  for (const k of ["x", "y", "z"]) {
    if (k !== longAxis) half[k] *= thicknessRatio;
  }

  return new CANNON.Vec3(half.x, half.y, half.z);
}

let armMesh, clawLMesh, clawRMesh, armGroup;
let clawPivot, clawLPivot, clawRPivot; // ★追加（setClawOpenで使うため）

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

// ===== アーム作成 =====
armMesh   = armGltf.scene;
clawLMesh = clawLGltf.scene;
clawRMesh = clawRGltf.scene;

// スケール（アームだけ上乗せ）
armMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE);
clawLMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE);
clawRMesh.scale.setScalar(WORLD_SCALE * ARM_SCALE);

// グループ化
armGroup = new THREE.Group();
armGroup.name = "ArmGroup";
armGroup.add(armMesh);

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
clawLPivot.position.set(0, -1, 1);
clawRPivot.position.set(0, -1, -1);

// ===== 爪メッシュは「ピボットの子」 =====
clawLPivot.add(clawLMesh);
clawRPivot.add(clawRMesh);

// ★爪の原点がヒンジに無い場合の補正（要調整）
clawLMesh.position.set(0, 0, 0);
clawRMesh.position.set(0, 0, 0);

// 置き場所（左上）
armGroup.position.set(-1.2, 1.6, 0.6);
armGroup.rotation.y = Math.PI / 2;
scene.add(armGroup);

  

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
boxMesh.scale.setScalar(WORLD_SCALE);

// 宣言は1回だけ
const yaw = Math.PI / 2;

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

// ✅ yaw する前に halfExtents を作る（4本分）
const stickHalf1 = makeStickHalfExtentsFromMesh(stick1Mesh, 0.04);
const stickHalf2 = makeStickHalfExtentsFromMesh(stick2Mesh, 0.04);
const stickHalf3 = makeStickHalfExtentsFromMesh(stick3Mesh, 0.04);
const stickHalf4 = makeStickHalfExtentsFromMesh(stick4Mesh, 0.04);

// ✅ その後で見た目を yaw 回転（4本＋箱）
stick1Mesh.rotation.y += yaw;
stick2Mesh.rotation.y += yaw;
stick3Mesh.rotation.y += yaw;
stick4Mesh.rotation.y += yaw;
boxMesh.rotation.y += yaw;

// ===== 物理：棒（静的）=====
stick1Body = new CANNON.Body({ mass: 0, material: matStick });
stick1Body.addShape(new CANNON.Box(stickHalf1));
stick1Body.position.copy(stick1Mesh.position);
stick1Body.quaternion.copy(stick1Mesh.quaternion);
world.addBody(stick1Body);

stick2Body = new CANNON.Body({ mass: 0, material: matStick });
stick2Body.addShape(new CANNON.Box(stickHalf2));
stick2Body.position.copy(stick2Mesh.position);
stick2Body.quaternion.copy(stick2Mesh.quaternion);
world.addBody(stick2Body);

stick3Body = new CANNON.Body({ mass: 0, material: matStick });
stick3Body.addShape(new CANNON.Box(stickHalf3));
stick3Body.position.copy(stick3Mesh.position);
stick3Body.quaternion.copy(stick3Mesh.quaternion);
world.addBody(stick3Body);

stick4Body = new CANNON.Body({ mass: 0, material: matStick });
stick4Body.addShape(new CANNON.Box(stickHalf4));
stick4Body.position.copy(stick4Mesh.position);
stick4Body.quaternion.copy(stick4Mesh.quaternion);
world.addBody(stick4Body);

  // ===== 物理：箱（動的）=====
  const boxSize = getBoxSize(boxMesh);
  const boxHalf = new CANNON.Vec3(boxSize.x / 2, boxSize.y / 2, boxSize.z / 2);

  boxBody = new CANNON.Body({
    mass: 1.0,
    material: matBox,
    linearDamping: 0.01,
    angularDamping: 0.02,
  });
  boxBody.addShape(new CANNON.Box(boxHalf));

  // テスト：絶対落ちる位置（棒の外）
  boxBody.position.set(0, 0.5, 0);
  boxBody.quaternion.copy(boxMesh.quaternion);
  world.addBody(boxBody);

  boxMesh.position.copy(boxBody.position);

  camera.lookAt(0, 0.4, 0);
}
let clawOpen01 = 0; // 0=閉じる, 1=開く

function setClawOpen(v01) {
  clawOpen01 = THREE.MathUtils.clamp(v01, 0, 1);

  // 開き角（ラジアン）0.0〜0.9 くらいで調整
  const ang = THREE.MathUtils.lerp(0.05, 0.9, clawOpen01);

  // 回転軸はモデル次第：z / y / x どれが正しいか試してOK
  clawLPivot.rotation.z =  ang;   // 左は＋
  clawRPivot.rotation.z = -ang;   // 右は−
}

loadScene().catch(console.error);

let lastT;
function animate(t) {
  requestAnimationFrame(animate);

  if (lastT == null) lastT = t;
  const dt = Math.min((t - lastT) / 1000, 1 / 30);
  lastT = t;

  world.step(1 / 60, dt, 3);

  if (boxMesh && boxBody) {
    boxMesh.position.copy(boxBody.position);
    boxMesh.quaternion.copy(boxBody.quaternion);
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
