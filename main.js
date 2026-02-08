import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const WORLD_SCALE = 0.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 2, 3.2);
camera.lookAt(0, 0.4, 0);

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

async function loadScene() {
  const [stickGltf, boxGltf, craneGltf] = await Promise.all([
    loader.loadAsync("./models/Stick.glb"),
    loader.loadAsync("./models/box.glb"),
    loader.loadAsync("./models/Crane_game.glb"),
  ]);

  // ===== クレーン台（見た目だけ）=====
  craneMesh = craneGltf.scene;
  craneMesh.scale.setScalar(WORLD_SCALE);
  centerToOriginAndGround(craneMesh);
  craneMesh.position.y -= 2;
  scene.add(craneMesh);

  // ===== 棒＆箱（見た目）=====
  stick1Mesh = stickGltf.scene.clone(true);
  stick2Mesh = stickGltf.scene.clone(true);
  boxMesh = boxGltf.scene;

  stick1Mesh.scale.setScalar(WORLD_SCALE);
  stick2Mesh.scale.setScalar(WORLD_SCALE);
  boxMesh.scale.setScalar(WORLD_SCALE);

  // ★ここで棒を横にしてる（見た目）
const yaw = Math.PI / 2;
// stick1Mesh.rotation.y += yaw;  ← いったんやめる
// stick2Mesh.rotation.y += yaw;  ← いったんやめる
// boxMesh.rotation.y += yaw;     ← これはそのままでもOK（箱は立方体なら影響小）

scene.add(stick1Mesh, stick2Mesh, boxMesh);

// 棒の間隔（位置は回転前でも後でもOK）
const stickGap = 0.12;
stick1Mesh.position.set(0, 0, -stickGap / 2);
stick2Mesh.position.set(0, 0,  stickGap / 2);

// ✅ 1) yawする前に halfExtents を作る
const stickHalf1 = makeStickHalfExtentsFromMesh(stick1Mesh, 0.04);
const stickHalf2 = makeStickHalfExtentsFromMesh(stick2Mesh, 0.04);

// ✅ 2) その後で見た目をyaw回転する
stick1Mesh.rotation.y += yaw;
stick2Mesh.rotation.y += yaw;
boxMesh.rotation.y += yaw; // 必要なら

// ✅ 3) Body作成→position/quaternion同期（yaw後のquaternionをコピー）
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


  stick2Body = new CANNON.Body({ mass: 0, material: matStick });
  stick2Body.addShape(new CANNON.Box(stickHalf2));
  stick2Body.position.copy(stick2Mesh.position);
  stick2Body.quaternion.copy(stick2Mesh.quaternion); // ★回転も同期
  world.addBody(stick2Body);

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
  boxBody.position.set(0, 0.5, 0.5);
  boxBody.quaternion.copy(boxMesh.quaternion);
  world.addBody(boxBody);

  boxMesh.position.copy(boxBody.position);

  camera.lookAt(0, 0.4, 0);
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
