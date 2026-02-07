import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
camera.position.set(0, 1.5, 2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

// Light
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(2, 3, 2);
scene.add(light);

const loader = new GLTFLoader();

// 読み込み
const [stickGltf, boxGltf] = await Promise.all([
  loader.loadAsync("./models/Stick.glb"),
  loader.loadAsync("./models/box.glb"),
]);

const stick1 = stickGltf.scene.clone(true);
const stick2 = stickGltf.scene.clone(true);
const box = boxGltf.scene;

scene.add(stick1, stick2, box);

// 棒配置
stick1.position.set(-0.25, 0, 0);
stick2.position.set( 0.25, 0, 0);

// 上面計算
const stickTopY = Math.max(
  new THREE.Box3().setFromObject(stick1).max.y,
  new THREE.Box3().setFromObject(stick2).max.y
);

const boxBottomY =
  new THREE.Box3().setFromObject(box).min.y;

// 箱を棒の上へ
box.position.y = (stickTopY - boxBottomY) + 0.001;

// 描画ループ
function animate(){
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
