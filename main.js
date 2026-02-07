import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as CANNON from "cannon-es";

const WORLD_SCALE = 0.25;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(
  60,
  innerWidth / innerHeight,
  0.05,
  100
);
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

  // 中心を原点へ
  root.position.sub(center);

  // 床面をY=0へ（最下点を0にする）
  const b2 = getBox3(root);
  root.position.y -= b2.min.y;
}

/**
 * ★重要：Stick.glb の向きがどうであっても
 * 「一番長い軸＝棒の長手方向」として判定し、
 * それ以外の2軸を thicknessRatio 倍に細くする
 */
function makeStickHalfExtentsFromMesh(stickMesh, thicknessRatio = 0.04) {
  const s = getBoxSize(stickMesh);

  const axes = [
    { k: "x", v: s.x },
    { k: "y", v: s.y },
    { k: "z", v: s.z },
  ].sort((a, b) => b.v - a.v);

  const longAxis = axes[0].k;

  const half = {
    x: s.x / 2,
    y: s.y / 2,
    z: s.z / 2,
  };

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

  const yaw = Math.PI / 2;
  stick1Mesh.rotation.y += yaw;
  stick2Mesh.rotation.y += yaw;
  boxMesh.rotation.y += yaw;

  scene.add(stick1Mesh, stick2Mesh, boxMesh);

  // 棒の“間”を作る（Z方向に離す）
  // ★0だと2本が完全に重なって当たり判定が二重になり、
  //   変に安定したり不自然になりやすいので少し開ける
  const stickGap = 0.12;
  stick1Mesh.position.set(0, 0, -stickGap / 2);
  stick2Mesh.position.set(0, 0, stickGap / 2);

  // ===== 物理：棒（静的）=====
  // ★「板」化しない“頑丈な自動判定”に変更
  const stickHalf = makeStickHalfExtentsFromMesh(stick1Mesh, 0.04);

  const stickSize = getBoxSize(stick1Mesh);

// 「長手＝X」「太さ＝Z/Y」と決め打ち（横棒想定）
const thicknessRatio = 0.04;
const half = new CANNON.Vec3(
  stickSize.x / 2,                 // 長手
  (stickSize.y / 2) * thicknessRatio, // 厚み（縦）細く
  (stickSize.z / 2) * thicknessRatio  // 厚み（奥）細く
);

stick1Body = new CANNON.Body({ mass: 0, material: matStick });
stick1Body.addShape(new CANNON.Box(half));
stick1Body.position.copy(stick1Mesh.position);
stick1Body.quaternion.copy(stick1Mesh.quaternion); // ★Threeの回転をそのまま
world.addBody(stick1Body);


  stick2Body = new CANNON.Body({ mass: 0, material: matStick });
  stick2Body.addShape(new CANNON.Box(stickHalf));
  stick2Body.position.set(
    stick2Mesh.position.x,
    stick2Mesh.position.y,
    stick2Mesh.position.z
  );
  stick2Body.quaternion.setFromEuler(
    stick2Mesh.rotation.x,
    stick2Mesh.rotation.y,
    stick2Mesh.rotation.z
  );
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

  // ★テスト用：確実に落ちる位置へ（棒から外れた場所）
  boxBody.position.set(1, 1, 1);

  // もし「棒の上から開始」に戻したいなら下を使ってOK
  // const stickTopY = Math.max(
  //   stick1Mesh.position.y + getBoxSize(stick1Mesh).y / 2,
  //   stick2Mesh.position.y + getBoxSize(stick2Mesh).y / 2
  // );
  // const startY = stickTopY + boxSize.y / 2 + 0.05;
  // boxBody.position.set(0, startY, 0);

  boxBody.quaternion.setFromEuler(
    boxMesh.rotation.x,
    boxMesh.rotation.y,
    boxMesh.rotation.z
  );
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
