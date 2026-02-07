import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const scene = new THREE.Scene();
const loader = new GLTFLoader();

// 1) 読み込み（Stick / box）
const [stickGltf, boxGltf] = await Promise.all([
  loader.loadAsync("models/Stick.glb"),
  loader.loadAsync("models/box.glb"),
]);

const stick1 = stickGltf.scene.clone(true);
const stick2 = stickGltf.scene.clone(true);
const box = boxGltf.scene;

// 2) とりあえずsceneへ追加
scene.add(stick1, stick2, box);

// 3) 棒2本を左右に配置（間隔は調整してOK）
stick1.position.set(-0.25, 0, 0);
stick2.position.set( 0.25, 0, 0);

// 4) bounding box を取って「棒の上面Y」「箱の底面Y」を求める
const stickBox1 = new THREE.Box3().setFromObject(stick1);
const stickBox2 = new THREE.Box3().setFromObject(stick2);

// 棒2本の上面のうち“高いほう”（基本同じ高さのはず）
const stickTopY = Math.max(stickBox1.max.y, stickBox2.max.y);

const boxBox = new THREE.Box3().setFromObject(box);
const boxBottomY = boxBox.min.y;

// 5) 箱を棒の上に「接地」させる（少し浮かせるとチラつき防止）
const epsilon = 0.001;
box.position.y += (stickTopY - boxBottomY) + epsilon;

// 6) 箱のX,Zを棒の中央へ（好みでズラして橋渡しの初期位置に）
box.position.x = 0;
box.position.z = 0;
