// 3D mockup：展开图 → 立体盒子预览（three.js）
// 构建：npx esbuild renderer/mockup.js --bundle --format=iife --global-name=MockupModule --outfile=renderer/vendor/mockup.bundle.js
// 注意：file:// 下 ES module 不可用，必须打成经典脚本（window.MockupModule）
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let boxGroup = null;

export function initMockup() {
  const wrap = document.getElementById('mockup-area');
  if (!wrap) return;
  if (renderer) {
    // 复用已有 renderer 时按当前可见尺寸重建（防止在隐藏页签中创建过 0 尺寸 canvas）
    wrap.innerHTML = '';
    const cw = canvasW(wrap), ch = wrap.clientHeight;
    renderer.setSize(cw, ch);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    wrap.appendChild(renderer.domElement);
    return;
  }
  wrap.innerHTML = '';
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const cw = canvasW(wrap), ch = wrap.clientHeight;
  renderer.setSize(cw, ch);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  wrap.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(300, 400, 250);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
  dir2.position.set(-250, 150, -200);
  scene.add(dir2);

  camera = new THREE.PerspectiveCamera(42, cw / ch, 1, 5000);
  camera.position.set(340, 280, 400);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  // 地面网格（辅助透视，非"框"）
  const grid = new THREE.GridHelper(600, 12, 0x3a3d4a, 0x2b2d3a);
  grid.position.y = -1;
  scene.add(grid);

  window.addEventListener('resize', onResize);
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// 3D canvas 宽度撑满容器（3D 透视渲染不拉伸变形，盒子大小由相机距离决定）
function canvasW(wrap) {
  return Math.max(240, wrap.clientWidth);
}

function onResize() {
  const wrap = document.getElementById('mockup-area');
  if (!wrap || !renderer) return;
  const w = canvasW(wrap), h = Math.max(240, wrap.clientHeight); // 高度同样设下限，防隐藏页签 resize 得到 0 尺寸
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function svgToCanvas(svgStr) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' })); // Blob URL 替代超长 data URL
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 转图失败')); };
    img.src = url;
  });
}

function panelTexture(canvas, panel, scale) {
  const w = Math.max(8, Math.round(panel.w * scale));
  const h = Math.max(8, Math.round(panel.h * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(canvas, panel.x * scale, panel.y * scale, w, h, 0, 0, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 把纹理旋转 90°（返回新纹理，旧纹理 dispose）。用于面板与 3D 面宽高互换的场景。
 * 方向：left 面逆时针（面板折叠边在右缘）、right 面顺时针（折叠边在左缘），保证折叠边贴合顶面。 */
function rotateTexture90(tex, clockwise) {
  const src = tex.image;
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext('2d');
  if (clockwise) {
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, c.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(src, 0, 0);
  tex.dispose();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 水平（h）或垂直（v）翻转纹理（返回新纹理，旧纹理 dispose）。用于校正 3D 面纹理方向（back 镜像、bottom/部分 top 颠倒）。 */
function flipTexture(tex, axis) {
  const src = tex.image;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  if (axis === 'h') {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, c.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(src, 0, 0);
  tex.dispose();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function faceConfig(side, dims) {
  const { x, y, z } = dims;
  switch (side) {
    case 'front': return { size: [x, y], pos: [0, 0, z / 2], rot: [0, 0, 0] };
    case 'back': return { size: [x, y], pos: [0, 0, -z / 2], rot: [0, Math.PI, 0] };
    case 'right': return { size: [z, y], pos: [x / 2, 0, 0], rot: [0, Math.PI / 2, 0] };
    case 'left': return { size: [z, y], pos: [-x / 2, 0, 0], rot: [0, -Math.PI / 2, 0] };
    case 'top': return { size: [x, z], pos: [0, y / 2, 0], rot: [-Math.PI / 2, 0, 0] };
    case 'bottom': return { size: [x, z], pos: [0, -y / 2, 0], rot: [Math.PI / 2, 0, 0] };
    default: return null;
  }
}

function buildBox(layout, canvas, scale) {
  const m3d = layout.mockup3d;
  const group = new THREE.Group();
  for (const [side, panelId] of Object.entries(m3d.faces)) {
    if (!panelId) continue;
    const panel = layout.panels.find((p) => p.id === panelId);
    if (!panel) continue;
    const cfg = faceConfig(side, m3d.dims);
    if (!cfg) continue;
    let tex = panelTexture(canvas, panel, scale);
    // 面板与 3D 面宽高互换（如天地盖左右围边为 H×D 横躺面板、3D 侧面为 D×H 竖立面）时
    // 先旋转 90° 再贴，避免纹理被拉伸变形；left 逆时针、right 顺时针（折叠边分别在面板右缘/左缘）
    if (Math.abs(panel.w - cfg.size[1]) < 0.001 && Math.abs(panel.h - cfg.size[0]) < 0.001) {
      tex = rotateTexture90(tex, side === 'right');
    }
    // 方向校正（mockup3d.texFlip，按各盒型展开图折叠关系声明）：back 水平镜像、bottom/双插盒 top 垂直翻转；'hv' = 水平+垂直（180°）
    const flip = m3d.texFlip && m3d.texFlip[side];
    if (flip && typeof flip === 'string') {
      for (const axis of flip) {
        if (axis === 'h' || axis === 'v') tex = flipTexture(tex, axis);
      }
    }
    const geo = new THREE.PlaneGeometry(cfg.size[0], cfg.size[1]);
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...cfg.pos);
    mesh.rotation.set(...cfg.rot);
    group.add(mesh);
  }
  // 注意：不再叠加整体边缘线框（wire）——每个面的贴图自带面板边框线，
  // 再叠半透明线框会在视觉上形成"双框"（此前用户反馈 3D 预览多出两个框）
  return group;
}

/** 释放 3D 组件的 GPU 资源（几何/材质/纹理），防反复切换累积显存 */
function disposeGroup(g) {
  if (!g) return;
  g.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

function setMockupPlaceholder(show) {  const wrap = document.getElementById('mockup-area');
  if (!wrap) return;
  let ph = wrap.querySelector('.mockup-placeholder');
  if (show) {
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'mockup-placeholder';
      ph.textContent = '✨ 生成主视觉后，这里自动折叠为 3D 盒子（拖拽旋转 · 滚轮缩放）';
      wrap.appendChild(ph);
    }
    ph.style.display = 'flex';
  } else if (ph) {
    ph.style.display = 'none';
  }
}

export async function renderMockup(template, size) {
  const wrap = document.getElementById('mockup-area');
  if (!wrap || !renderer) return false;
  const layout = template.build(size);
  if (!layout.mockup3d) return false;
  // 无主视觉图时不叠空盒子，显示占位提示（避免用户误以为界面多了空框）
  if (!window.__app || !window.__app.state || !window.__app.state.currentImage) {
    if (boxGroup) { disposeGroup(boxGroup); scene.remove(boxGroup); boxGroup = null; }
    setMockupPlaceholder(true);
    return true;
  }
  try {
    const scale = 3;
    const svgStr = window.__app.buildSvg(scale, { bleed: 0, showLabel: false });
    const canvas = await svgToCanvas(svgStr);
    if (boxGroup) { disposeGroup(boxGroup); scene.remove(boxGroup); }
    boxGroup = buildBox(layout, canvas, scale);
    scene.add(boxGroup);
    setMockupPlaceholder(false);
    const { x, y, z } = layout.mockup3d.dims;
    const maxDim = Math.max(x, y, z);
    // 相机距离：fov 42° 下视野高 = 2·dist·tan21° ≈ 0.77·dist；正方体从俯视方向的投影跨度约 1.55×边长，
    // dist 需 ≥ 2.0×边长 才不至于出画（原 1.2× 在近正方体时上下各裁约 40%）
    const dist = maxDim * 2.0;
    // 保持原俯视角度方向 (1.6, 1.35, 1.9) 归一化
    const dir = [1.6, 1.35, 1.9];
    const len = Math.hypot(...dir);
    camera.position.set(dist * dir[0] / len, dist * dir[1] / len, dist * dir[2] / len);
    controls.target.set(0, 0, 0);
    controls.update();
    return { ok: true, meshes: boxGroup ? boxGroup.children.length : 0, dims: [x, y, z], dist };
  } catch (e) {
    console.error('3D mockup 渲染失败:', e);
    return { ok: false, err: String(e && e.message) };
  }
}
