"use strict";

// Hero smoke: a small GPU fluid simulation (semi-Lagrangian advection, vorticity confinement, Jacobi pressure solve;
// the classic "stable fluids" approach). A source releases prism-coloured dye that swirls and fades; moving the mouse
// anywhere on the page pushes the air (weaker the farther away it is), so the smoke is dragged and curls naturally.
// WebGL 2 with half-float render targets; without them shader.js (the static prism shader) runs instead.
// The smoke pours from above the page straight down onto the name: a narrow jet at first that thickens and
// brightens over a few seconds after load.
(function () {
  const canvas = document.querySelector(".shader");
  if (!canvas) return;
  // check support on a throwaway canvas first: a canvas can only ever hold one kind of context, and shader.js needs
  // the real one if the simulation can't run here
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe || !probe.getExtension("EXT_color_buffer_float")) return; // shader.js takes over
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  gl.getExtension("EXT_color_buffer_float");
  window.__smokeActive = true;


  // ---------------------------------------------------------------------------------------------------------------
  // shaders
  const baseVertex = `#version 300 es
    precision highp float;
    in vec2 aPosition;
    out vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;
  const header = (body) => `#version 300 es
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB;
    out vec4 outColor;
    ${body}`;

  const sources = {
    clear: header(`
      uniform sampler2D uTexture; uniform float value;
      void main() { outColor = value * texture(uTexture, vUv); }`),
    splat: header(`
      uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
      void main() {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        outColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
      }`),
    advection: header(`
      uniform sampler2D uVelocity, uSource; uniform vec2 texelSize; uniform float dt, dissipation;
      void main() {
        vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
        outColor = texture(uSource, coord) / (1.0 + dissipation * dt);
      }`),
    divergence: header(`
      uniform sampler2D uVelocity;
      void main() {
        float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
        float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
        vec2 C = texture(uVelocity, vUv).xy;
        if (vL.x < 0.0) L = -C.x;
        if (vR.x > 1.0) R = -C.x;
        if (vT.y > 1.0) T = -C.y;
        if (vB.y < 0.0) B = -C.y;
        outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }`),
    curl: header(`
      uniform sampler2D uVelocity;
      void main() {
        float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
        float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
        outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
      }`),
    vorticity: header(`
      uniform sampler2D uVelocity, uCurl; uniform float curl, dt;
      void main() {
        float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
        float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
        float C = texture(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 velocity = texture(uVelocity, vUv).xy + force * dt;
        outColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
      }`),
    pressure: header(`
      uniform sampler2D uPressure, uDivergence;
      void main() {
        float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
        float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
        float divergence = texture(uDivergence, vUv).x;
        outColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
      }`),
    gradientSubtract: header(`
      uniform sampler2D uPressure, uVelocity;
      void main() {
        float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
        float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
        vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
        outColor = vec4(velocity, 0.0, 1.0);
      }`),
    // smoke over the page: light mode tints the paper, dark mode glows; fine static grain where there is smoke
    display: header(`
      uniform sampler2D uTexture; uniform float dark; uniform vec2 resolution;
      float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main() {
        vec3 dye = texture(uTexture, vUv).rgb;
        float density = max(dye.r, max(dye.g, dye.b));
        vec3 hue = dye / max(density, 0.0001);
        float a = 1.0 - exp(-density * 1.6);
        vec3 page = mix(vec3(0.984, 0.984, 0.98), vec3(0.067, 0.067, 0.075), dark);
        vec3 light = mix(page, hue, a * 0.82);
        vec3 glow = page + hue * a * 0.9;
        vec3 col = mix(light, glow, dark);
        col += (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.06 * a;
        outColor = vec4(col, 1.0);
      }`),
  };

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  let programs;
  try {
    const vertex = compile(gl.VERTEX_SHADER, baseVertex);
    programs = {};
    for (const name of Object.keys(sources)) {
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, sources[name]));
      gl.bindAttribLocation(program, 0, "aPosition");
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        uniforms[info.name] = gl.getUniformLocation(program, info.name);
      }
      programs[name] = { program, uniforms };
    }
  } catch (e) {
    console.warn("smoke unavailable:", e);
    canvas.remove(); // the CSS gradient on .hero-art remains
    return;
  }

  // full-screen quad
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // render targets
  function createFBO(w, h, internalFormat, format) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      attach(unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return unit;
      },
    };
  }
  function createDoubleFBO(w, h, internalFormat, format) {
    let a = createFBO(w, h, internalFormat, format);
    let b = createFBO(w, h, internalFormat, format);
    return {
      width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
    };
  }

  const SIM_RES = 128;
  const DYE_RES = 512;
  let velocity, dye, divergence, curl, pressure;

  const MAX_TEXTURE = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  function resolution(res) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const max = Math.min(MAX_TEXTURE, Math.round(res * aspect));
    const min = Math.round(res);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { w: max, h: min } : { w: min, h: max };
  }
  function initFramebuffers() {
    const sim = resolution(SIM_RES);
    const dyeRes = resolution(DYE_RES);
    velocity = createDoubleFBO(sim.w, sim.h, gl.RG16F, gl.RG);
    dye = createDoubleFBO(dyeRes.w, dyeRes.h, gl.RGBA16F, gl.RGBA);
    divergence = createFBO(sim.w, sim.h, gl.R16F, gl.RED);
    curl = createFBO(sim.w, sim.h, gl.R16F, gl.RED);
    pressure = createDoubleFBO(sim.w, sim.h, gl.R16F, gl.RED);
  }

  function use(name) {
    gl.useProgram(programs[name].program);
    return programs[name].uniforms;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // simulation step
  const config = { velocityDissipation: 1.1, dyeDissipation: 0.6, pressure: 0.8, iterations: 20, curl: 30 };

  function splat(x, y, dx, dy, color, radius) {
    let u = use("splat");
    gl.uniform1i(u.uTarget, velocity.read.attach(0));
    gl.uniform1f(u.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(u.point, x, y);
    gl.uniform3f(u.color, dx, dy, 0);
    gl.uniform1f(u.radius, radius);
    blit(velocity.write);
    velocity.swap();
    if (color) {
      gl.uniform1i(u.uTarget, dye.read.attach(0));
      gl.uniform3f(u.color, color[0], color[1], color[2]);
      blit(dye.write);
      dye.swap();
    }
  }

  function step(dt) {
    gl.disable(gl.BLEND);
    let u = use("curl");
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    blit(curl);

    u = use("vorticity");
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uCurl, curl.attach(1));
    gl.uniform1f(u.curl, config.curl);
    gl.uniform1f(u.dt, dt);
    blit(velocity.write);
    velocity.swap();

    u = use("divergence");
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    u = use("clear");
    gl.uniform1i(u.uTexture, pressure.read.attach(0));
    gl.uniform1f(u.value, config.pressure);
    blit(pressure.write);
    pressure.swap();

    u = use("pressure");
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.iterations; i++) {
      gl.uniform1i(u.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    u = use("gradientSubtract");
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uPressure, pressure.read.attach(0));
    gl.uniform1i(u.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    u = use("advection");
    gl.uniform2f(u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, velocity.read.attach(0));
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, config.velocityDissipation);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(u.uSource, dye.read.attach(1));
    gl.uniform1f(u.dissipation, config.dyeDissipation);
    blit(dye.write);
    dye.swap();
  }

  function render() {
    const u = use("display");
    gl.uniform2f(u.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(u.uTexture, dye.read.attach(0));
    gl.uniform1f(u.dark, document.documentElement.dataset.theme === "dark" ? 1 : 0);
    gl.uniform2f(u.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
    blit(null);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the source: just above the top edge, aimed at the name (so its origin is never visible)
  const name = document.querySelector("h1.name");
  function source() {
    const r = canvas.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    return { x: (n.left + n.width * 0.32 - r.left) / r.width, y: 1.02 }; // above the first name
  }

  // optical-prism palette: milky pink light with violet, magenta, red-orange and gold
  const palette = [
    [1.0, 0.86, 0.97], [0.62, 0.36, 1.0], [0.95, 0.38, 0.78], [1.0, 0.5, 0.35], [1.0, 0.8, 0.4], [1.0, 0.9, 0.98],
  ];
  function paletteColor(k) {
    const n = palette.length;
    const f = ((k % 1) + 1) % 1 * n;
    const i = Math.floor(f);
    const a = palette[i], b = palette[(i + 1) % n], t = f - i;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // a narrow jet that sways only slightly, so it lands on the name; it starts shortly after load and builds up
  const DELAY = 0.4; // seconds before the first smoke appears
  // tilt of the jet (positive = towards the left): opens left, then every 3.5-6 s eases to another preset aim
  const AIMS = [0.3, 0.18, 0.06, -0.06, -0.16, -0.26];
  let aimFrom = 0.28, aimTo = 0.28, aimStart = 0, aimLength = 4.5;
  function aim(time) {
    if (time - aimStart > aimLength) {
      aimFrom = aimTo;
      const choices = AIMS.filter((a) => Math.abs(a - aimFrom) > 0.1);
      aimTo = choices[Math.floor(Math.random() * choices.length)];
      aimStart = time;
      aimLength = 3.5 + Math.random() * 2.5;
    }
    const k = Math.min(1, (time - aimStart) / (aimLength * 0.6));
    return aimFrom + (aimTo - aimFrom) * k * k * (3 - 2 * k);
  }
  const BUILD = 3.5; // seconds until it reaches full strength
  function emit(time, dt) {
    const ramp = Math.min(1, Math.max(0, (time - DELAY) / BUILD));
    if (ramp <= 0) return;
    const eased = ramp * ramp * (3 - 2 * ramp);
    const s = source();
    // the first jet is tilted down-left onto "Yousif"; afterwards it eases between varied aims (left, centre, right)
    const angle = -Math.PI / 2 - aim(time) + Math.sin(time * 1.3) * 0.05;
    const speed = 42 - 8 * eased; // slow enough that the smoke pools around the name rather than plunging past it
    const color = paletteColor(time * 0.16).map((c) => c * 9 * (0.35 + 0.65 * eased) * dt);
    splat(s.x + Math.sin(time * 0.7) * 0.012, s.y, Math.cos(angle) * speed, Math.sin(angle) * speed, color,
      0.0035 + 0.0055 * eased); // narrow at first, wider as it builds
  }

  // ---------------------------------------------------------------------------------------------------------------
  // the pointer pushes the air anywhere on the page: full strength over the canvas, weaker (and applied at the
  // nearest edge) the farther away it is, so distant movement still draws the smoke out a little
  const pointer = { x: 0, y: 0, moved: false, dx: 0, dy: 0, strength: 0 };
  let last = null;
  window.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    let x = (e.clientX - r.left) / r.width;
    let y = 1 - (e.clientY - r.top) / r.height;
    const outside = Math.max(0, -x, x - 1, -y, y - 1) * Math.max(r.width, r.height) / r.height;
    const strength = 1 / (1 + outside * outside * 6);
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    if (last) {
      pointer.dx += (x - last.x) * strength;
      pointer.dy += (y - last.y) * strength;
      pointer.moved = true;
    }
    pointer.x = x;
    pointer.y = y;
    last = { x, y };
    start();
  }, { passive: true });

  function applyPointer() {
    if (!pointer.moved) return;
    const force = 5200;
    splat(pointer.x, pointer.y, pointer.dx * force * (canvas.width / canvas.height), pointer.dy * force, null, 0.0028);
    pointer.dx = 0;
    pointer.dy = 0;
    pointer.moved = false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // loop
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let visible = true;
  let frame = 0;
  let lastTime = performance.now();
  let simTime = 0;

  // returns false while the canvas has no real size yet (e.g. a hidden tab); the simulation waits for it
  function resize() {
    if (canvas.clientWidth < 16 || canvas.clientHeight < 16) return false;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (w === canvas.width && h === canvas.height && velocity) return true;
    canvas.width = w;
    canvas.height = h;
    initFramebuffers();
    return true;
  }

  function advance(dt) {
    simTime += dt;
    emit(simTime, dt);
    applyPointer();
    step(dt);
  }

  function loop(now) {
    if (!velocity && !warmUp()) {
      frame = 0;
      return;
    }
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    advance(dt);
    render();
    frame = visible && !document.hidden && !reduceMotion.matches ? requestAnimationFrame(loop) : 0;
  }
  function start() {
    if (!frame && !reduceMotion.matches) {
      lastTime = performance.now();
      frame = requestAnimationFrame(loop);
    }
  }

  // the page opens with clean air and the smoke arrives; for reduced motion, simulate ahead to a finished still frame
  function warmUp() {
    if (!resize()) return false;
    if (reduceMotion.matches) for (let i = 0; i < 420; i++) advance(1 / 60);
    render();
    return true;
  }
  warmUp();

  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      const had = !!velocity;
      if (!resize()) return;
      if (!had) warmUp();
      render();
      start();
    }).observe(canvas);
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
  if (toggle) toggle.addEventListener("click", () => render());
  start();

  // local testing only: step the simulation by hand (hidden tabs get no animation frames)
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    window.__smoke = {
      advance(seconds) {
        if (!velocity && !warmUp()) return "no size yet";
        for (let i = 0; i < Math.round(seconds * 60); i++) advance(1 / 60);
        render();
        return simTime.toFixed(2);
      },
    };
  }
})();
