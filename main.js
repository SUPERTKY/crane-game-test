
import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const canvasContainer = document.body;

// --- 基本セットアップ ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(2.2, 1.6, 3.0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
canvasContainer.appendChild(renderer.domElement);

// --- ライト（テクスチャが真っ黒になるのを防ぐ） ---
const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.8);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(5, 6, 3);
scene.add(dir);

const ambient = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambient);

// --- 床（見やすくするだけ。橋渡し棒は後で追加してOK） ---
const floorGeo = new THREE.PlaneGeometry(20, 20);
const floorMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 1 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

// --- カメラ操作（右ドラッグで回転・ホイールでズーム） ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.7, 0);
controls.enableDamping = true;

// --- GLB読み込み ---
const loader = new GLTFLoader();

let craneRoot = null;
let armObject = null;
const ARM_NAME = "Arm"; // Blenderでアーム（動かしたい部品）にこの名前を付けると拾えます

async function loadGLB(url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err)
    );
  });
}

function findByNameDeep(root, name) {
  let found = null;
  root.traverse((obj) => {
    if (obj.name === name) found = obj;
  });
  return found;
}

const initial = {
  cranePos: new THREE.Vector3(0, 0, 0),
  armPos: new THREE.Vector3(0, 0, 0),
};

async function init() {
  try {
    // クレーン（アーム付き）モデル
    craneRoot = await loadGLB("/models/crane.glb");
    scene.add(craneRoot);

    // 影・色空間など（軽い補正）
    craneRoot.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
        if (obj.material && obj.material.map) {
          obj.material.map.colorSpace = THREE.SRGBColorSpace;
        }
      }
    });

    // 動かしたいパーツを名前で探す（無ければ全体を動かすだけにする）
    armObject = findByNameDeep(craneRoot, ARM_NAME);

    // リセット用に初期座標保存
    initial.cranePos.copy(craneRoot.position);
    if (armObject) initial.armPos.copy(armObject.position);

    // 景品（任意）
    try {
      const prize = await loadGLB("/models/prize.glb");
      prize.position.set(0, 0.35, 0); // 棒の上に置く想定
      scene.add(prize);
    } catch {
      // prize.glb が無いなら無視
    }

  } catch (e) {
    console.error(e);
    alert("モデルの読み込みに失敗しました。/public/models/crane.glb があるか確認してね。");
  }
}

await init();

// --- キー入力（簡易） ---
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

function resetPositions() {
  if (craneRoot) craneRoot.position.copy(initial.cranePos);
  if (armObject) armObject.position.copy(initial.armPos);
}

// --- ループ ---
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(0.033, clock.getDelta());

  // 速度（お好みで）
  const moveSpeed = 1.2;  // 左右前後
  const liftSpeed = 0.9;  // 上下

  // どこを動かすか：Armが見つかればArm、無ければクレーン全体
  const target = armObject || craneRoot;

  if (target) {
    // WASD: XZ平面
    if (keys.has("w")) target.position.z -= moveSpeed * dt;
    if (keys.has("s")) target.position.z += moveSpeed * dt;
    if (keys.has("a")) target.position.x -= moveSpeed * dt;
    if (keys.has("d")) target.position.x += moveSpeed * dt;

    // Q/E: Y上下
    if (keys.has("q")) target.position.y += liftSpeed * dt;
    if (keys.has("e")) target.position.y -= liftSpeed * dt;

    // R: リセット
    if (keys.has("r")) resetPositions();
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();

// --- リサイズ対応 ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
