import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.4, 2.8);
camera.lookAt(0, 0.9, 0);

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

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 1 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
scene.add(floor);

scene.add(new THREE.AxesHelper(1));

const loader = new GLTFLoader();

async function loadScene() {
  const [stickGltf, boxGltf] = await Promise.all([
    loader.loadAsync("./models/Stick.glb"),
    loader.loadAsync("./models/box.glb"),
  ]);

  const stick1 = stickGltf.scene.clone(true);
  const stick2 = stickGltf.scene.clone(true);
  const box = boxGltf.scene;
function tint(root, colorHex) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    if (o.material.emissive) {
      o.material.emissive.setHex(colorHex);
      o.material.emissiveIntensity = 1.0;
    }
  });
}

tint(stick1, 0xff0000); // 赤
tint(stick2, 0x0000ff); // 青

  // ✅ 箱だけサイズ変更
  box.scale.set(0.5, 0.5, 0.5);

  // ✅ 横向き（床の上で向きを変える）：Y軸90度
  const yaw = Math.PI / 2;
  stick1.rotation.y += yaw;
  stick2.rotation.y += yaw;
  box.rotation.y += yaw;

  scene.add(stick1, stick2, box);

  // ✅ 棒の間隔（名前を gap じゃなく stickGap にする）
  const stickGap = 1.0;
  stick1.position.set(-stickGap / 2, 0, 0);
  stick2.position.set( stickGap / 2, 0, 0);

  // --- 箱を棒の上に接地 ---
  const b1 = new THREE.Box3().setFromObject(stick1);
  const b2 = new THREE.Box3().setFromObject(stick2);
  const stickTopY = Math.max(b1.max.y, b2.max.y);

  const bb = new THREE.Box3().setFromObject(box);
  const boxBottomY = bb.min.y;

  const epsilon = 0.001;
  box.position.set(0, 0, 0);
  box.position.y = (stickTopY - boxBottomY) + epsilon;

  camera.lookAt(0, stickTopY + 0.2, 0);
}

loadScene().catch((e) => {
  console.error(e);
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

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
