import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const WORLD_SCALE = 0.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 3.2);
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
    friction: 0.35,
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

  // 中心を原点へ
  root.position.sub(center);

  // 床面をY=0へ（最下点を0にする）
  const b2 = getBox3(root);
  root.position.y -= b2.min.y;
}

async function loadScene() {
  const [stickGltf, boxGltf, craneGltf] = await Promise.all([
    loader.loadAsync("./models/Stick.glb"),
    loader.loadAsync("./models/box.glb"),
    loader.loadAsync("./models/Crane_game.glb"), // ★追加
  ]);

  // ===== クレーン台（見た目だけ）=====
  craneMesh = craneGltf.scene;
  craneMesh.scale.setScalar(WORLD_SCALE);

  // 台の中心を(0,0,0)へ、床面をY=0へ
  centerToOriginAndGround(craneMesh);
// 台を少し下げる
craneMesh.position.y -= 1;

  // 必要なら向き合わせ（まずは無しでOK。ズレてたらY回転を調整）
  // craneMesh.rotation.y += Math.PI / 2;

  scene.add(craneMesh);

  // ===== 棒＆箱（見た目）=====
  stick1Mesh = stickGltf.scene.clone(true);
  stick2Mesh = stickGltf.scene.clone(true);
  boxMesh = boxGltf.scene;

  stick1Mesh.scale.setScalar(WORLD_SCALE);
  stick2Mesh.scale.setScalar(WORLD_SCALE);
  boxMesh.scale.setScalar(WORLD_SCALE);

  const yaw = Math.PI / 2;
  stick1Mesh.rotation.y += yaw;
  stick2Mesh.rotation.y += yaw;
  boxMesh.rotation.y += yaw;

  scene.add(stick1Mesh, stick2Mesh, boxMesh);

  // 棒の“間”を作る（Z方向に離す）
  const stickGap = 0.6;
  stick1Mesh.position.set(0, 0, -stickGap / 2);
  stick2Mesh.position.set(0, 0,  stickGap / 2);

  // ===== 物理：棒（静的）=====
  const stickSize = getBoxSize(stick1Mesh);
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

  const stickTopY = Math.max(
    stick1Mesh.position.y + stickSize.y / 2,
    stick2Mesh.position.y + stickSize.y / 2
  );
  const startY = stickTopY + boxSize.y / 2 + 0.002;

  // ★箱は中心(0,*,0)に置く（＝クレーン台の中心）
  boxBody.position.set(0, startY, 0);
  boxBody.quaternion.setFromEuler(boxMesh.rotation.x, boxMesh.rotation.y, boxMesh.rotation.z);
  world.addBody(boxBody);

  boxMesh.position.set(boxBody.position.x, boxBody.position.y, boxBody.position.z);

  camera.lookAt(0, stickTopY + 0.15, 0);
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
