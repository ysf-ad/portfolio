"use strict";

// Hero art: an "optical prism" cloud behind the header: bright milky light whose lower edge splits into a spectrum,
// drifting like smoke (domain-warped noise), with film grain; it fades into the page colour. The pointer stirs it:
// the smoke is pulled in and swirled around the cursor with some turbulence, and a small "puncture" with a spectral
// fringe appears where the cursor pierces the light.
// Plain WebGL 1, no library. Pauses when off screen or in a background tab; draws one still frame for visitors
// who prefer reduced motion; if WebGL is missing, the panel's CSS gradient stays visible instead.
(function () {
  const canvas = document.querySelector(".shader");
  if (!canvas || window.__smokeActive) return; // smoke.js (the fluid simulation) is running instead
  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  if (!gl) return;

  const vertexSource = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;

  const fragmentSource = `
    precision highp float;
    uniform vec2 u_res;
    uniform float u_time;
    uniform float u_dark;
    uniform vec2 u_center;   // glow centre as a fraction of the canvas (already eased towards the pointer)
    uniform float u_radius;  // glow radius as a fraction of the canvas height
    uniform float u_hover;   // 0..1, pointer over the header
    uniform vec2 u_pointer;  // pointer as a fraction of the canvas (eased)
    uniform float u_stir;    // how hard the smoke is being stirred: hover + pointer speed, decays when still

    // sin-free hash (Dave Hoskins): no diagonal banding, unlike fract(sin(dot(...)))
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      mat2 rot = mat2(0.8, 0.6, -0.6, 0.8); // rotate every octave so nothing lines up with the pixel grid
      for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot * p * 2.03 + 11.7; a *= 0.5; }
      return v;
    }

    // light split by a prism: violet -> magenta -> red -> orange -> yellow
    vec3 spectrum(float k) {
      vec3 violet = vec3(0.42, 0.22, 0.9), magenta = vec3(0.86, 0.2, 0.62), red = vec3(0.92, 0.22, 0.25),
           orange = vec3(1.0, 0.55, 0.18), yellow = vec3(0.98, 0.84, 0.3);
      float s = clamp(k, 0.0, 1.0) * 4.0;
      return s < 1.0 ? mix(violet, magenta, s) : s < 2.0 ? mix(magenta, red, s - 1.0) : s < 3.0 ? mix(red, orange, s - 2.0) : mix(orange, yellow, s - 3.0);
    }

    void main() {
      // coordinates in canvas-height units, so the cloud keeps its shape on any aspect ratio
      vec2 p = gl_FragCoord.xy / u_res.y;
      vec2 c = u_center * vec2(u_res.x / u_res.y, 1.0);
      float t = u_time * 0.12;

      // the pointer disturbs the smoke locally: samples are pulled towards it, swirled around it, and roughened by
      // fast turbulence, so the cloud looks magnetically dragged and stirred rather than moved as a whole
      vec2 pp = u_pointer * vec2(u_res.x / u_res.y, 1.0);
      vec2 dv = p - pp;
      float r2 = dot(dv, dv);
      float field = exp(-r2 / 0.022) * u_stir;                        // falls off over ~0.15 of the height
      vec2 swirl = vec2(-dv.y, dv.x);
      vec2 turbulence = vec2(fbm(dv * 9.0 + u_time * 0.9), fbm(dv * 9.0 - u_time * 0.9 + 5.2)) - 0.5;
      p += (-dv * 0.55 + swirl * 1.6 + turbulence * 0.09) * field;
      // far field: a weak pull that reaches across the header, so a distant pointer still draws the smoke out
      // into a thin streak towards it (falls off slowly, and is gentler than the local stir)
      float far = u_hover / (1.0 + r2 / 0.09);
      // (sampling further from the pointer makes the smoke appear to reach towards it)
      p += dv * 0.22 * far * (1.0 - exp(-r2 / 0.03));

      // a smoky cloud: domain-warped noise makes the outline and the band drift and curl
      c += vec2(0.05 * sin(t * 0.9), 0.03 * cos(t * 0.7));
      float radius = u_radius;
      vec2 rel = (p - c) / radius;
      vec2 q = vec2(fbm(rel * 1.1 + t), fbm(rel * 1.1 - t + 4.3));
      vec2 w = rel + 0.34 * (q - 0.5);
      float d = length(w * vec2(0.82, 1.0));

      vec3 page = mix(vec3(0.984, 0.984, 0.98), vec3(0.067, 0.067, 0.075), u_dark);
      vec3 milk = mix(vec3(0.995, 0.93, 0.985), vec3(0.17, 0.12, 0.26), u_dark);

      // body: bright milky light, tinted pink on the upper left and peach on the upper right
      vec3 tint = mix(vec3(1.0, 0.6, 0.95), vec3(1.0, 0.7, 0.56), smoothstep(-0.6, 0.6, w.x));
      tint = mix(tint, tint * 0.55, u_dark);
      vec3 body = mix(milk, tint, 0.8 * smoothstep(0.15, 1.0, d) * smoothstep(-0.8, 0.45, w.y));
      float cloud = smoothstep(1.35, 0.3, d);
      vec3 col = mix(page, body, cloud);

      // the prism band: dispersed colour along the lower edge of the light, breathing slowly
      float across = (d - 0.9 + 0.05 * sin(t * 1.3 + w.x * 2.0)) / 0.17;
      float lower = smoothstep(0.35, -0.55, w.y);
      float k = 0.5 + 0.42 * w.x + 0.18 * across + 0.12 * sin(t * 0.8);
      vec3 band = spectrum(k);
      float bandMask = exp(-across * across * 1.1) * lower * mix(0.7, 0.85, u_dark) * (1.0 + 0.2 * u_hover);
      col = mix(col, band, clamp(bandMask, 0.0, 1.0));

      // the puncture: a bright pinhole where the pointer pierces the light, ringed by a split-colour fringe
      float rr = sqrt(r2);
      float lit = smoothstep(1.4, 0.4, d);                            // only where there is light to pierce
      float fringe = exp(-pow((rr - 0.032) / 0.014, 2.0));
      vec3 fringeColor = spectrum(fract(atan(dv.y, dv.x) / 6.2831 + u_time * 0.15) * 0.8 + 0.1);
      col = mix(col, fringeColor, clamp(fringe * u_stir * lit * 0.55, 0.0, 1.0));
      col = mix(col, mix(vec3(1.0), vec3(1.0, 0.95, 1.0), u_dark), exp(-r2 / 0.00018) * u_stir * lit * 0.8);

      // heavy film grain, as in a print: static, only where there is light
      float g = (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.085;
      col += g * smoothstep(1.5, 0.4, d);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (e) {
    canvas.remove(); // keep the CSS fallback
    return;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(program, "u_res");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uDark = gl.getUniformLocation(program, "u_dark");
  const uCenter = gl.getUniformLocation(program, "u_center");
  const uRadius = gl.getUniformLocation(program, "u_radius");
  const uHover = gl.getUniformLocation(program, "u_hover");
  const uPointer = gl.getUniformLocation(program, "u_pointer");
  const uStir = gl.getUniformLocation(program, "u_stir");

  // interaction: the pointer stirs the smoke locally (see the shader); faster movement stirs harder
  const header = canvas.closest("header");
  const pointer = { x: 0.5, y: 0.5, inside: false, speed: 0 };
  const glow = { x: 0.5, y: 0.5, hover: 0, stir: 0, ready: false };
  header.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = 1 - (e.clientY - r.top) / r.height;
    if (pointer.inside) pointer.speed = Math.min(1, pointer.speed + Math.hypot((x - pointer.x) * r.width, (y - pointer.y) * r.height) / 140);
    pointer.x = x;
    pointer.y = y;
    pointer.inside = true;
    start();
  });
  header.addEventListener("pointerleave", () => {
    pointer.inside = false;
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let visible = true;
  let frame = 0;
  const startTime = performance.now() - 20000; // start mid-motion rather than at a symmetric pose

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5); // grain looks right and it stays cheap
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw(now) {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - startTime) / 1000);
    gl.uniform1f(uDark, document.documentElement.dataset.theme === "dark" ? 1 : 0);
    // wide screens: glow to the right of the name; phones: behind the top of the header
    const narrow = canvas.clientWidth < 760;
    const home = { x: narrow ? 0.8 : 0.76, y: narrow ? 0.7 : 0.66 };
    // the cursor's influence follows it with a little lag (feels like dragging through smoke)
    if (!glow.ready) Object.assign(glow, { x: pointer.x, y: pointer.y, ready: true });
    glow.x += (pointer.x - glow.x) * 0.18;
    glow.y += (pointer.y - glow.y) * 0.18;
    glow.hover += ((pointer.inside ? 1 : 0) - glow.hover) * 0.06;
    pointer.speed *= 0.92; // turbulence calms down when the pointer rests
    const targetStir = pointer.inside ? 0.45 + 0.55 * pointer.speed : 0;
    glow.stir += (targetStir - glow.stir) * 0.08;
    // subtle lean of the whole cloud towards the pointer: a small fraction of the offset, less when far away,
    // and never far enough to sit behind the text
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const ox = (glow.x - home.x) * aspect;
    const oy = glow.y - home.y;
    const reach = 1 / (1 + (ox * ox + oy * oy) * 1.5);
    const lean = 0.14 * reach * glow.hover;
    const cx = Math.max(narrow ? 0.7 : 0.68, home.x + (glow.x - home.x) * lean);
    const cy = Math.min(0.8, Math.max(0.5, home.y + oy * lean));
    gl.uniform2f(uCenter, cx, cy);
    gl.uniform1f(uRadius, narrow ? 0.34 : 0.4);
    gl.uniform1f(uHover, glow.hover);
    gl.uniform2f(uPointer, glow.x, glow.y);
    gl.uniform1f(uStir, glow.stir);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function loop(now) {
    draw(now);
    frame = visible && !document.hidden && !reduceMotion.matches ? requestAnimationFrame(loop) : 0;
  }
  function start() {
    if (!frame) frame = requestAnimationFrame(loop);
  }

  // size the drawing buffer from the element's real size, and keep it in sync: measuring once at start-up can
  // happen before layout, which left a 1-pixel-wide canvas stretched across the header (visible as streaks)
  resize();
  draw(performance.now());
  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      resize();
      draw(performance.now());
    }).observe(canvas);
  } else {
    window.addEventListener("resize", () => {
      resize();
      draw(performance.now());
    });
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) start();
  });
  reduceMotion.addEventListener("change", start);
  const toggle = document.querySelector(".theme-toggle");
  if (toggle) toggle.addEventListener("click", () => draw(performance.now()));
  start();
})();
