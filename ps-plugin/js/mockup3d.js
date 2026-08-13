/* mockup3d.js - 3D 预览（M4，F5）
 * 兼容：CEP 8/9（Chromium 57/61，ES5）。three.js 锁 r128（WebGL1 兼容，最后 UMD 稳定版）。
 * 依赖：js/templates.js（BoxTemplates）、lib/three.min.js、lib/OrbitControls.js（window.THREE）。
 * 独立版 renderer/mockup.js 移植，API 适配 r128：outputEncoding/tex.encoding = sRGBEncoding（非 r152+ 的 colorSpace）。
 * 数据流：模板页选的盒型（psState）→ 画展开图 canvas（面板矩形 + AI 主视觉图）→ 折叠为 3D 盒子 →
 *         拖拽旋转/滚轮缩放 → 「截图入文档」toDataURL → 复用 placeImage 通道。 */
(function () {
  'use strict';

  var renderer = null;
  var scene = null;
  var camera = null;
  var controls = null;
  var boxGroup = null;

  function canvasW(wrap) { return Math.max(200, wrap.clientWidth); }

  /* ---- 初始化（页签首次激活时调用，避免隐藏容器 0 尺寸） ---- */
  function init() {
    var wrap = document.getElementById('mockup-area');
    if (!wrap) return false;
    if (typeof THREE === 'undefined') return false; // three 未加载：页签保留占位，不中断切换
    try {
      if (renderer) {
        wrap.innerHTML = '';
        var cw = canvasW(wrap), ch = Math.max(200, wrap.clientHeight);
        renderer.setSize(cw, ch);
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        wrap.appendChild(renderer.domElement);
        return true;
      }
      wrap.innerHTML = '';
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      var cw0 = canvasW(wrap), ch0 = Math.max(200, wrap.clientHeight);
      renderer.setSize(cw0, ch0);
      renderer.outputEncoding = THREE.sRGBEncoding; // r128：sRGB 输出（r152+ 为 outputColorSpace）
      wrap.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      var dir = new THREE.DirectionalLight(0xffffff, 1.1);
      dir.position.set(300, 400, 250);
      scene.add(dir);
      var dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
      dir2.position.set(-250, 150, -200);
      scene.add(dir2);

      camera = new THREE.PerspectiveCamera(42, cw0 / ch0, 1, 5000);
      camera.position.set(340, 280, 400);
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;

      var grid = new THREE.GridHelper(600, 12, 0x3a3d4a, 0x2b2d3a);
      grid.position.y = -1;
      scene.add(grid);

      window.addEventListener('resize', onResize);
      animate();
      return true;
    } catch (e) {
      // three/WebGL 初始化失败：释放半成品，留占位提示，不中断页签切换
      renderer = null; scene = null; camera = null; controls = null;
      return false;
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
  }

  function onResize() {
    var wrap = document.getElementById('mockup-area');
    if (!wrap || !renderer) return;
    var w = canvasW(wrap), h = Math.max(200, wrap.clientHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ---- 展开图画布：面板矩形 + 主视觉图（contain）+ 标签 ---- */
  function findPanel(layout, id) {
    for (var i = 0; i < layout.panels.length; i++) {
      if (layout.panels[i].id === id) return layout.panels[i];
    }
    return null;
  }

  function drawContain(ctx, img, x, y, w, h) {
    var r = Math.min(w / img.width, h / img.height);
    var dw = img.width * r, dh = img.height * r;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /** 把主视觉图贴到 face 面板（onload 后调用，此时图已 decode） */
  function drawFaceOnCanvas(canvas, layout, scale, img) {
    if (!img) return;
    var face = findPanel(layout, layout.panel);
    if (!face) return;
    var ctx = canvas.getContext('2d');
    var x = Math.round(face.x * scale), y = Math.round(face.y * scale);
    var w = Math.round(face.w * scale), h = Math.round(face.h * scale);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    drawContain(ctx, img, x, y, w, h);
    ctx.restore();
  }

  function buildFlatCanvas(layout, scale) {
    var c = document.createElement('canvas');
    var W = Math.round(layout.width * scale);
    var H = Math.round(layout.height * scale);
    c.width = W;
    c.height = H;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    var out = { canvas: c, img: null, imgLoaded: false };
    var faceImg = currentFaceImage();
    if (faceImg) {
      // onload 后重绘 face 区（首次绘制时图未 decode，face 区是纯色底）；改 out.imgLoaded（引用）供外部轮询
      out.img = new Image();
      out.img.onload = function () {
        out.imgLoaded = true;
        drawFaceOnCanvas(out.canvas, layout, scale, out.img);
      };
      out.img.onerror = function () { out.imgLoaded = true; }; // 加载失败也结束等待（不贴图即可）
      out.img.src = faceImg;
    }
    for (var i = 0; i < layout.panels.length; i++) {
      var p = layout.panels[i];
      var x = Math.round(p.x * scale), y = Math.round(p.y * scale);
      var w = Math.round(p.w * scale), h = Math.round(p.h * scale);
      if (p.kind === 'window') {
        ctx.fillStyle = 'rgba(190, 215, 255, 0.55)';
        ctx.strokeStyle = '#4f8cff';
      } else if (p.kind === 'flap') {
        ctx.fillStyle = '#f6f8fb';
        ctx.strokeStyle = '#b6c0cf';
      } else if (p.kind === 'face') {
        ctx.fillStyle = '#e2e8f1';
        ctx.strokeStyle = '#9aa7b8';
      } else {
        ctx.fillStyle = '#eef1f6';
        ctx.strokeStyle = '#9aa7b8';
      }
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (p.kind !== 'window' && w > 40 && h > 16) {
        ctx.fillStyle = 'rgba(34, 42, 53, 0.4)';
        ctx.font = Math.max(8, Math.round(scale * 2.2)) + 'px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(p.label, x + w / 2, y + h / 2 + 3);
      }
    }
    return out;
  }

  /** 当前 AI 主视觉图（ai.js 暴露的 psAiState）；无则 null */
  function currentFaceImage() {
    var s = window.psAiState;
    if (s && s.images && s.images.length > 0 && s.active >= 0 && s.images[s.active]) {
      return s.images[s.active].dataUrl;
    }
    return null;
  }

  /* ---- 盒子构建（独立版移植，r128 适配） ---- */
  function panelTexture(canvas, panel, scale) {
    var w = Math.max(8, Math.round(panel.w * scale));
    var h = Math.max(8, Math.round(panel.h * scale));
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(canvas, panel.x * scale, panel.y * scale, w, h, 0, 0, w, h);
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding; // r128
    tex.anisotropy = 4;
    return tex;
  }

  function rotateTexture90(tex, clockwise) {
    var src = tex.image;
    var c = document.createElement('canvas');
    c.width = src.height;
    c.height = src.width;
    var ctx = c.getContext('2d');
    if (clockwise) {
      ctx.translate(c.width, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(0, c.height);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(src, 0, 0);
    tex.dispose();
    var t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 4;
    return t;
  }

  function faceConfig(side, dims) {
    var x = dims.x, y = dims.y, z = dims.z;
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
    var m3d = layout.mockup3d;
    var group = new THREE.Group();
    var sides = ['front', 'back', 'right', 'left', 'top', 'bottom'];
    for (var si = 0; si < sides.length; si++) {
      var side = sides[si];
      var panelId = m3d.faces[side];
      if (!panelId) continue;
      var panel = findPanel(layout, panelId);
      if (!panel) continue;
      var cfg = faceConfig(side, m3d.dims);
      if (!cfg) continue;
      var tex = panelTexture(canvas, panel, scale);
      // 面板与 3D 面宽高互换时先旋转 90° 再贴（left 逆时针、right 顺时针）
      if (Math.abs(panel.w - cfg.size[1]) < 0.001 && Math.abs(panel.h - cfg.size[0]) < 0.001) {
        tex = rotateTexture90(tex, side === 'right');
      }
      var geo = new THREE.PlaneGeometry(cfg.size[0], cfg.size[1]);
      var mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      mesh.rotation.set(cfg.rot[0], cfg.rot[1], cfg.rot[2]);
      group.add(mesh);
    }
    return group;
  }

  function disposeGroup(g) {
    if (!g) return;
    g.traverse(function (obj) {
      if (!obj.isMesh) return;
      if (obj.geometry) obj.geometry.dispose();
      var mats = obj.material ? (obj.material.length ? obj.material : [obj.material]) : [];
      for (var i = 0; i < mats.length; i++) {
        if (!mats[i]) continue;
        if (mats[i].map) mats[i].map.dispose();
        mats[i].dispose();
      }
    });
  }

  /* ---- 渲染当前盒型 3D（异步：需等主视觉图加载；带超时与并发保护） ---- */
  var renderSeq = 0;
  function renderMockup() {
    var wrap = document.getElementById('mockup-area');
    if (!wrap || !renderer) { if (!init()) return Promise.reject(new Error('3D 初始化失败')); }
    var seq = ++renderSeq; // 请求序号：连点刷新时旧请求结果丢弃
    var st = window.psState;
    var t = BoxTemplates[st.boxType];
    var size = st.size;
    var layout = t.build(size);
    if (!layout.mockup3d) return Promise.resolve({ ok: false, err: '该盒型无 3D 数据' });
    var scale = 3;
    var fc = buildFlatCanvas(layout, scale);
    if (fc.img) {
      return new Promise(function (resolve) {
        var deadline = Date.now() + 5000; // 5s 超时兜底：罕见情况下 dataURL 既不 load 也不 error
        var check = function () {
          if (fc.imgLoaded || Date.now() > deadline) {
            if (seq === renderSeq) resolve(renderBox(layout, fc.canvas, scale));
            else resolve({ ok: false, stale: true });
            return;
          }
          setTimeout(check, 30);
        };
        check();
      });
    }
    return Promise.resolve(seq === renderSeq ? renderBox(layout, fc.canvas, scale) : { ok: false, stale: true });
  }

  function renderBox(layout, canvas, scale) {
    if (boxGroup) { disposeGroup(boxGroup); scene.remove(boxGroup); }
    boxGroup = buildBox(layout, canvas, scale);
    scene.add(boxGroup);
    var d = layout.mockup3d.dims;
    var maxDim = Math.max(d.x, d.y, d.z);
    var dist = maxDim * 2.0;
    var dir = [1.6, 1.35, 1.9];
    var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    camera.position.set(dist * dir[0] / len, dist * dir[1] / len, dist * dir[2] / len);
    controls.target.set(0, 0, 0);
    controls.update();
    return { ok: true, meshes: boxGroup.children.length, dims: [d.x, d.y, d.z] };
  }

  /* ---- 截图入文档（复用 placeImage 通道） ---- */
  function shotToDoc(cb) {
    if (!renderer) { cb && cb(new Error('3D 未初始化')); return; }
    var url;
    try { url = renderer.domElement.toDataURL('image/png'); } catch (e) { cb && cb(e); return; }
    var st = window.psState || {};
    var xMm = Number(document.getElementById('m4-x').value) || 0;
    var yMm = Number(document.getElementById('m4-y').value) || 0;
    var wMm = Number(document.getElementById('m4-w').value) || 100;
    var hMm = Number(document.getElementById('m4-h').value) || 100;
    var filePath;
    try {
      filePath = window.psNode.preparePlaceImage(url).path;
    } catch (e) { cb && cb(e); return; }
    psbridge.placeImage({ filePath: filePath, xMm: xMm, yMm: yMm, wMm: wMm, hMm: hMm, group: '3D 预览', bleed: st.bleed }).then(function (r) {
      cb && cb(null, r);
    }).catch(cb);
  }

  window.toyboxMockup = {
    init: init,
    renderMockup: renderMockup,
    shotToDoc: shotToDoc,
    hasFace: function () { return !!currentFaceImage(); },
  };

  /* ---- M4 页按钮 ---- */
  var m4Status = document.getElementById('m4-status');
  function setM4(msg, ok) {
    if (m4Status) {
      m4Status.textContent = msg;
      m4Status.className = 'status' + (ok ? ' ok' : (ok === false ? ' err' : ''));
    }
  }
  var btnRefresh = document.getElementById('btn-m4-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', function () {
      setM4('🔄 刷新预览…');
      renderMockup().then(function (r) {
        if (r && r.stale) return; // 被更新的请求取代，静默
        setM4(r && r.ok ? '✅ 已刷新（' + r.meshes + ' 个面）' : ('⚠ ' + (r && r.err || '渲染失败')), !!(r && r.ok));
      }).catch(function (e) {
        setM4('❌ ' + (e && e.message || e), false);
      });
    });
  }
  var btnShot = document.getElementById('btn-m4-shot');
  if (btnShot) {
    btnShot.addEventListener('click', function () {
      setM4('📸 截图入文档中…');
      shotToDoc(function (err, r) {
        if (err) setM4('❌ ' + (err && err.message || err), false);
        else setM4('✅ 3D 截图已放入「' + r.group + '」图层组（' + Math.round(r.actualMm.w * 10) / 10 + '×' + Math.round(r.actualMm.h * 10) / 10 + 'mm）', true);
      });
    });
  }
})();
