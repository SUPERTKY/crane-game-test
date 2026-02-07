// main.js（配置だけ：棒2本＋箱を棒の上に置く／前から見るカメラ）
// ※ index.html から <script type="module" src="./main.js"></script> で読み込む想定

import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";

// --- 基本セットアップ ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
// 前から（プレイヤー視点っぽく）
camera.position.set(0, 1.4, 2.8);
camera.lookAt(0, 0.9, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
document.body.appendChild(renderer.domElement);

// --- ライト（GLBが真っ黒/真っ白対策） ---
scene.add(new THREE.AmbientLight(0xffffff, 0.75));

const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(2, 3, 2);
scene.add(dir);

// --- 床（位置の把握がしやすい） ---
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 1 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

// 原点の目印（不要なら消してOK）
scene.add(new THREE.AxesHelper(1));

// --- モデル読み込み ---
const loader = new GLTFLoader();

async function loadScene() {
  // Stick / box を読み込み
  const [stickGltf, boxGltf] = await Promise.all([
    loader.loadAsync("./models/Stick.glb"),
    loader.loadAsync("./models/box.glb"),
  ]);

  // Stick を2本に複製
  const stick1 = stickGltf.scene.clone(true);
  const stick2 = stickGltf.scene.clone(true);
  const box = boxGltf.scene;

  scene.add(stick1, stick2, box);

  // --- 配置（棒2本を左右に） ---
  const gap = 0.55; // 棒間隔（ここを調整）
  stick1.position.set(-gap / 2, 0, 0);
  stick2.position.set(gap / 2, 0, 0);

  // --- 箱を棒の上に「接地」させる ---
  // 棒の上面Yを取得
  const b1 = new THREE.Box3().setFromObject(stick1);
  const b2 = new THREE.Box3().setFromObject(stick2);
  const stickTopY = Math.max(b1.max.y, b2.max.y);

  // 箱の底面Yを取得
  const bb = new THREE.Box3().setFromObject(box);
  const boxBottomY = bb.min.y;

  // 箱を棒の上に置く（少し浮かせてチラつき防止）
  const epsilon = 0.001;
  box.position.set(0, 0, 0);
  box.position.y = (stickTopY - boxBottomY) + epsilon;

  // 橋渡しっぽく、ほんの少し斜めにしたいなら（不要なら消してOK）
  // box.rotation.y = THREE.MathUtils.degToRad(5);

  // カメラが必ずモデルを捉えるように、中心へ向け直し（保険）
  camera.lookAt(0, stickTopY + 0.2, 0);
}

loadScene().catch((e) => {
  console.error(e);
  // 読み込み失敗時に「真っ白」になりがちなので目印を出す
  const errText = document.createElement("div");
  errText.style.position = "fixed";
  errText.style.left = "12px";
  errText.style.top = "12px";
  errText.style.padding = "10px 12px";
  errText.style.background = "rgba(0,0,0,0.7)";
  errText.style.color = "#fff";
  errText.style.fontFamily = "monospace";
  errText.style.whiteSpace = "pre";
  errText.textContent =
    "GLB load failed.\nCheck paths:\n- ./models/Stick.glb\n- ./models/box.glb\nOpen DevTools Console for details.";
  document.body.appendChild(errText);
});

// --- リサイズ対応 ---
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- 描画ループ ---
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
