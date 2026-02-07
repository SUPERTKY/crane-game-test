import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

// ========== サイズ調整（全体を小さくしたいならここ） ==========
const WORLD_SCALE = 0.25; // ← 0.2〜0.5で調整（小さくするほど縮む）

// ========== three 基本 ==========
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.0, 2.0);
camera.lookAt(0, 0.5, 0);

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

scene.add(new THREE.AxesHelper(0.5));

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ========== 物理（cannon-es） ==========
const world = new CANNON.World({
  gravity: new CANNON.Vec3(0, -9.82, 0),
});
function addCraneBase({ center = { x: 0, y: 0, z: 0 }, innerW = 1.6, innerD = 1.2, wallH = 0.5, thick = 0.05 } = {}) {
  // ===== 見た目（three） =====
  const group = new THREE.Group();
  group.position.set(center.x, center.y, center.z);
  scene.add(group);

  // 床（見た目）
  const floorMesh = new THREE.Mesh(
    new THREE.BoxGeometry(innerW + thick * 2, thick, innerD + thick * 2),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 1 })
  );
  floorMesh.position.set(0, -thick / 2, 0);
  group.add(floorMesh);

  // 壁（見た目）
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });

  const wallL = new THREE.Mesh(new THREE.BoxGeometry(thick, wallH, innerD + thick * 2), wallMat);
  wallL.position.set(-(innerW / 2 + thick / 2), wallH / 2, 0);
  group.add(wallL);

  const wallR = new THREE.Mesh(new THREE.BoxGeometry(thick, wallH, innerD + thick * 2), wallMat);
  wallR.position.set( (innerW / 2 + thick / 2), wallH / 2, 0);
  group.add(wallR);

  const wallF = new THREE.Mesh(new THREE.BoxGeometry(innerW + thick * 2, wallH, thick), wallMat);
  wallF.position.set(0, wallH / 2, -(innerD / 2 + thick / 2));
  group.add(wallF);

  const wallB = new THREE.Mesh(new THREE.BoxGeometry(innerW + thick * 2, wallH, thick), wallMat);
  wallB.position.set(0, wallH / 2,  (innerD / 2 + thick / 2));
  group.add(wallB);

  // ===== 物理（cannon-es） =====
  const baseMat = new CANNON.Material("base");

  // 床（物理）
  {
    const shape = new CANNON.Box(new CANNON.Vec3((innerW + thick * 2) / 2, thick / 2, (innerD + thick * 2) / 2));
    const body = new CANNON.Body({ mass: 0, material: baseMat });
    body.addShape(shape);
    body.position.set(center.x, center.y - thick / 2, center.z);
    world.addBody(body);
  }

  // 壁（物理）
  function addWall(w, h, d, x, y, z) {
    const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
    const body = new CANNON.Body({ mass: 0, material: baseMat });
    body.addShape(shape);
    body.position.set(center.x + x, center.y + y, center.z + z);
    world.addBody(body);
  }

  addWall(thick, wallH, innerD + thick * 2, -(innerW / 2 + thick / 2), wallH / 2, 0);
  addWall(thick, wallH, innerD + thick * 2,  (innerW / 2 + thick / 2), wallH / 2, 0);
  addWall(innerW + thick * 2, wallH, thick, 0, wallH / 2, -(innerD / 2 + thick / 2));
  addWall(innerW + thick * 2, wallH, thick, 0, wallH / 2,  (innerD / 2 + thick / 2));

  return group;
}

world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;

// 接触材質（滑りやすさ）
const matStick = new CANNON.Material("stick");
const matBox = new CANNON.Material("box");

world.defaultContactMaterial.friction = 0.4;
world.defaultContactMaterial.restitution = 0.0;

world.addContactMaterial(
  new CANNON.ContactMaterial(matStick, matBox, {
    friction: 0.35,      // ここを下げると滑りやすい
    restitution: 0.0,
  })
);

// ========== 読み込み ==========
const loader = new GLTFLoader();

let boxMesh, stick1Mesh, stick2Mesh;
let boxBody, stick1Body, stick2Body;

function getBoxSize(obj3d) {
  const box3 = new THREE.Box3().setFromObject(obj3d);
  const size = new THREE.Vector3();
  box3.getSize(size);
  return size;
}

async function loadScene() {
  const [stickGltf, boxGltf] = await Promise.all([
    loader.loadAsync("./models/Stick.glb"),
    loader.loadAsync("./models/box.glb"),
  ]);

  // ---- 見た目メッシュ ----
  stick1Mesh = stickGltf.scene.clone(true);
  stick2Mesh = stickGltf.scene.clone(true);
  boxMesh = boxGltf.scene;

  // 全体縮小（見た目）
  stick1Mesh.scale.setScalar(WORLD_SCALE);
  stick2Mesh.scale.setScalar(WORLD_SCALE);
  boxMesh.scale.setScalar(WORLD_SCALE);

  // 横向き（必要なら）
  const yaw = Math.PI / 2;
  stick1Mesh.rotation.y += yaw;
  stick2Mesh.rotation.y += yaw;
  boxMesh.rotation.y += yaw;

  scene.add(stick1Mesh, stick2Mesh, boxMesh);

  // ---- 棒を2本に配置（“間”を作る：Zで離す）----
  const stickGap = 0.6; // ← 棒の間隔（世界単位。WORLD_SCALEとは別で調整）
  stick1Mesh.position.set(0, 0, -stickGap / 2);
  stick2Mesh.position.set(0, 0,  stickGap / 2);

  // ---- 物理形状（棒）：見た目の棒の寸法から、当たり判定用の箱を作る ----
  // ここでは「見た目の棒モデルを包む箱」を当たり判定にします（最小実装で安定）
  const stickSize = getBoxSize(stick1Mesh); // scale後のサイズ
  const stickHalf = new CANNON.Vec3(stickSize.x / 2, stickSize.y / 2, stickSize.z / 2);

  stick1Body = new CANNON.Body({ mass: 0, material: matStick });
  stick1Body.addShape(new CANNON.Box(stickHalf));
  stick1Body.position.set(stick1Mesh.position.x, stick1Mesh.position.y, stick1Mesh.position.z);
  stick1Body.quaternion.setFromEuler(stick1Mesh.rotation.x, stick1Mesh.rotation.y, stick1Mesh.rotation.z);
  world.addBody(stick1Body);

  stick2Body = new CANNON.Body({ mass: 0, material: matStick });
  stick2Body.addShape(new CANNON.Box(stickHalf));
  stick2Body.position.set(stick2Mesh.position.x, stick2Mesh.position.y, stick2Mesh.position.z);
  stick2Body.quaternion.setFromEuler(stick2Mesh.rotation.x, stick2Mesh.rotation.y, stick2Mesh.rotation.z);
  world.addBody(stick2Body);

  // ---- 物理形状（箱）：見た目の箱モデルを包む箱（動く） ----
  const boxSize = getBoxSize(boxMesh);
  const boxHalf = new CANNON.Vec3(boxSize.x / 2, boxSize.y / 2, boxSize.z / 2);

  boxBody = new CANNON.Body({
    mass: 1.0,              // 重さ（大きいほど動きにくい）
    material: matBox,
    linearDamping: 0.01,    // 空気抵抗
    angularDamping: 0.02,
  });
  boxBody.addShape(new CANNON.Box(boxHalf));

  // 箱を棒の上に置く（棒上面 + 箱半分）
  const stickTopY = Math.max(stick1Mesh.position.y + stickSize.y / 2, stick2Mesh.position.y + stickSize.y / 2);
  const startY = stickTopY + boxSize.y / 2 + 0.002;

  boxBody.position.set(0, startY, 0);
  boxBody.quaternion.setFromEuler(boxMesh.rotation.x, boxMesh.rotation.y, boxMesh.rotation.z);
  world.addBody(boxBody);

  // 見た目も物理の初期位置へ
  boxMesh.position.set(boxBody.position.x, boxBody.position.y, boxBody.position.z);

  // カメラを少し合わせる
  camera.lookAt(0, stickTopY + 0.15, 0);
}

loadScene().catch(console.error);

// ========== ループ（物理→描画） ==========
let lastT;
function animate(t) {
  requestAnimationFrame(animate);

  if (lastT == null) lastT = t;
  const dt = Math.min((t - lastT) / 1000, 1 / 30);
  lastT = t;

  // 物理ステップ
  world.step(1 / 60, dt, 3);

  // 物理→見た目 同期
  if (boxMesh && boxBody) {
    boxMesh.position.copy(boxBody.position);
    boxMesh.quaternion.copy(boxBody.quaternion);
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
