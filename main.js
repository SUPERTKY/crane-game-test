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

// --- 床 ---
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

const cameraViews = {
  front: {
    position: new THREE.Vector3(0, 1.7, 3.4),
    target: new THREE.Vector3(0, 0.7, 0),
    label: "前",
  },
  side: {
    position: new THREE.Vector3(3.4, 1.5, 0),
    target: new THREE.Vector3(0, 0.7, 0),
    label: "横",
  },
};

let currentCameraView = "front";

function applyCameraView(viewKey) {
  const view = cameraViews[viewKey];
  if (!view) return;
  camera.position.copy(view.position);
  controls.target.copy(view.target);
  controls.update();
  currentCameraView = viewKey;
  const label = document.querySelector(".camera-label");
  if (label) label.textContent = `カメラ：${view.label}`;
}

// --- GLB読み込み（見た目だけの補助） ---
const loader = new GLTFLoader();
let decorativeCrane = null;

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

async function loadDecorativeCrane() {
  try {
    decorativeCrane = await loadGLB("/models/crane.glb");
    decorativeCrane.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
        if (obj.material && obj.material.map) {
          obj.material.map.colorSpace = THREE.SRGBColorSpace;
        }
      }
    });
    scene.add(decorativeCrane);
  } catch {
    // なくてもOK
  }
}

await loadDecorativeCrane();

// --- クレーンゲーム（橋渡し）用の簡易リグ ---
const game = {
  area: {
    minX: -1.2,
    maxX: 1.2,
    minZ: -1.2,
    maxZ: 1.2,
  },
  floorY: 0,
  barY: 0.35,
  barGap: 0.28,
  clawTopY: 1.45,
  clawBottomY: 0.18,
  dropZone: new THREE.Vector3(0, 0, 1.45),
  moveSpeed: 1.1,
  liftSpeed: 0.9,
  state: "move",
  grabbed: false,
  cooldown: 0,
};

const rig = new THREE.Group();
scene.add(rig);

const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a8cff, metalness: 0.3, roughness: 0.4 });
const accentMat = new THREE.MeshStandardMaterial({ color: 0xffc857, metalness: 0.2, roughness: 0.5 });

function createFrame() {
  const railGeo = new THREE.BoxGeometry(2.9, 0.08, 0.08);
  const railLeft = new THREE.Mesh(railGeo, frameMat);
  const railRight = railLeft.clone();
  railLeft.position.set(0, 1.4, -1.25);
  railRight.position.set(0, 1.4, 1.25);
  railLeft.rotation.y = Math.PI / 2;
  railRight.rotation.y = Math.PI / 2;

  const bridgeGeo = new THREE.BoxGeometry(2.8, 0.12, 0.2);
  const bridge = new THREE.Mesh(bridgeGeo, frameMat);
  bridge.position.set(0, 1.4, 0);

  const columnGeo = new THREE.BoxGeometry(0.12, 1.4, 0.12);
  const columnOffsets = [
    [-1.4, 0, -1.2],
    [1.4, 0, -1.2],
    [-1.4, 0, 1.2],
    [1.4, 0, 1.2],
  ];
  const columns = columnOffsets.map(([x, y, z]) => {
    const column = new THREE.Mesh(columnGeo, frameMat);
    column.position.set(x, y + 0.7, z);
    return column;
  });

  rig.add(railLeft, railRight, bridge, ...columns);
}

const carriage = new THREE.Group();
rig.add(carriage);

function createCarriage() {
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.3), accentMat);
  body.position.set(0, 1.34, 0);
  carriage.add(body);
}

const clawGroup = new THREE.Group();
carriage.add(clawGroup);

const rope = new THREE.Mesh(
  new THREE.CylinderGeometry(0.015, 0.015, 1, 8),
  new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.1, roughness: 0.7 })
);
rope.position.set(0, 0.85, 0);
carriage.add(rope);

const clawPivot = new THREE.Group();
clawGroup.add(clawPivot);

const clawBody = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.15, 12), accentMat);
clawBody.rotation.x = Math.PI / 2;
clawPivot.add(clawBody);

const prongs = [];
for (let i = 0; i < 3; i += 1) {
  const prong = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.22, 6), frameMat);
  const angle = (i / 3) * Math.PI * 2;
  prong.position.set(Math.cos(angle) * 0.08, -0.12, Math.sin(angle) * 0.08);
  prong.rotation.z = Math.PI / 2;
  prong.rotation.y = angle;
  clawPivot.add(prong);
  prongs.push(prong);
}

function createPrizeBridge() {
  const barGeo = new THREE.BoxGeometry(1.1, 0.05, 0.08);
  const barMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.6 });
  const leftBar = new THREE.Mesh(barGeo, barMat);
  const rightBar = new THREE.Mesh(barGeo, barMat);
  leftBar.position.set(-game.barGap, game.barY, 0);
  rightBar.position.set(game.barGap, game.barY, 0);
  rig.add(leftBar, rightBar);
}

const prize = new THREE.Mesh(
  new THREE.BoxGeometry(0.22, 0.18, 0.22),
  new THREE.MeshStandardMaterial({ color: 0xff6b6b, roughness: 0.4, metalness: 0.1 })
);
prize.position.set(0, game.barY + 0.14, 0);
scene.add(prize);

function buildRig() {
  createFrame();
  createCarriage();
  createPrizeBridge();
  carriage.position.set(0, 0, 0);
  clawGroup.position.set(0, 1.1, 0);
  clawPivot.position.set(0, 0, 0);
}

buildRig();

// --- キー入力 ---
const keys = new Set();
window.addEventListener("keydown", (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key === " ") e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

function clampPosition() {
  carriage.position.x = THREE.MathUtils.clamp(carriage.position.x, game.area.minX, game.area.maxX);
  carriage.position.z = THREE.MathUtils.clamp(carriage.position.z, game.area.minZ, game.area.maxZ);
}

function setClawHeight(y) {
  const clamped = THREE.MathUtils.clamp(y, game.clawBottomY, game.clawTopY);
  clawGroup.position.y = clamped;
  rope.scale.y = (game.clawTopY - clamped) / 1.2 + 0.2;
  rope.position.y = (game.clawTopY + clamped) / 2;
}

function setProngOpen(openRatio) {
  prongs.forEach((prong, index) => {
    const base = (index / 3) * Math.PI * 2;
    prong.rotation.y = base + openRatio * 0.5;
  });
}

function resetGame() {
  carriage.position.set(0, 0, 0);
  setClawHeight(game.clawTopY);
  game.state = "move";
  game.grabbed = false;
  game.cooldown = 0;
  prize.position.set(0, game.barY + 0.14, 0);
  prize.rotation.set(0, 0, 0);
  prize.userData.held = false;
  setProngOpen(0.6);
}

resetGame();

const cameraToggle = document.getElementById("cameraToggle");
if (cameraToggle) {
  cameraToggle.addEventListener("click", () => {
    const nextView = currentCameraView === "front" ? "side" : "front";
    applyCameraView(nextView);
  });
}

applyCameraView(currentCameraView);

function startDrop() {
  if (game.state !== "move") return;
  game.state = "drop";
}

function tryGrab() {
  const clawWorld = new THREE.Vector3();
  clawPivot.getWorldPosition(clawWorld);
  const prizeWorld = new THREE.Vector3();
  prize.getWorldPosition(prizeWorld);
  const dist = clawWorld.distanceTo(prizeWorld);
  if (dist < 0.2 && prizeWorld.y <= game.barY + 0.22) {
    prize.userData.held = true;
    clawPivot.add(prize);
    const local = clawPivot.worldToLocal(prizeWorld.clone());
    prize.position.copy(local);
    game.grabbed = true;
  }
}

function releasePrize() {
  if (!prize.userData.held) return;
  prize.userData.held = false;
  scene.add(prize);
  prize.position.set(game.dropZone.x, game.barY - 0.05, game.dropZone.z);
  prize.rotation.set(0, 0, 0);
  game.grabbed = false;
}

function updateState(dt) {
  switch (game.state) {
    case "move": {
      const move = game.moveSpeed * dt;
      if (keys.has("w") || keys.has("arrowup")) carriage.position.z -= move;
      if (keys.has("s") || keys.has("arrowdown")) carriage.position.z += move;
      if (keys.has("a") || keys.has("arrowleft")) carriage.position.x -= move;
      if (keys.has("d") || keys.has("arrowright")) carriage.position.x += move;
      clampPosition();
      setProngOpen(0.6);
      if (keys.has(" ")) startDrop();
      if (keys.has("r")) resetGame();
      break;
    }
    case "drop": {
      setProngOpen(0.4);
      setClawHeight(clawGroup.position.y - game.liftSpeed * dt);
      if (clawGroup.position.y <= game.clawBottomY + 0.01) {
        game.state = "grab";
        game.cooldown = 0.15;
      }
      break;
    }
    case "grab": {
      setProngOpen(0.1);
      game.cooldown -= dt;
      if (game.cooldown <= 0) {
        tryGrab();
        game.state = "lift";
      }
      break;
    }
    case "lift": {
      setProngOpen(0.1);
      setClawHeight(clawGroup.position.y + game.liftSpeed * dt);
      if (clawGroup.position.y >= game.clawTopY - 0.01) {
        game.state = "return";
      }
      break;
    }
    case "return": {
      setProngOpen(0.2);
      const dir = new THREE.Vector3(
        game.dropZone.x - carriage.position.x,
        0,
        game.dropZone.z - carriage.position.z
      );
      const dist = dir.length();
      if (dist > 0.02) {
        dir.normalize();
        carriage.position.x += dir.x * game.moveSpeed * dt;
        carriage.position.z += dir.z * game.moveSpeed * dt;
        clampPosition();
      } else {
        game.state = "release";
        game.cooldown = 0.3;
      }
      break;
    }
    case "release": {
      setProngOpen(0.7);
      game.cooldown -= dt;
      if (game.cooldown <= 0) {
        releasePrize();
        game.state = "move";
      }
      break;
    }
    default:
      break;
  }
}

// --- HUD ---
const hud = document.getElementById("hud");
function updateHud() {
  if (!hud) return;
  const stateLabel = {
    move: "移動中",
    drop: "下降中",
    grab: "キャッチ",
    lift: "上昇中",
    return: "戻り中",
    release: "リリース",
  }[game.state];
  hud.querySelector(".state").textContent = stateLabel || "-";
  hud.querySelector(".status").textContent = game.grabbed ? "景品あり" : "なし";
}

// --- ループ ---
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(0.033, clock.getDelta());
  updateState(dt);
  updateHud();
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
