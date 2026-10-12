// Iridescent liquid blob. Plain three.js (no r3f): one mesh, one material, one rAF loop.
import { useEffect, useRef } from "react";
import * as THREE from "three";

// Ashima/Stefan Gustavson 3D simplex noise (MIT).
const NOISE = /* glsl */ `
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 perm(vec4 x){return m289(((x*34.)+1.)*x);}
vec4 tis(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=m289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
uniform float uTime;
vec3 warp(vec3 p){
  float n=snoise(p*.62+vec3(uTime*.14,uTime*.09,0.))*.26+snoise(p*1.3-uTime*.07)*.05;
  return p+normalize(p)*n;
}`;

// A tiny studio of coloured light panels, baked into a PMREM env map: this is what the blob reflects.
function studio(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0b0718");
  const panel = (color: string, intensity: number, w: number, h: number, pos: [number, number, number]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  panel("#f2c879", 2.6, 9, 6, [-6, 4, 3]); // gold key, upper left
  panel("#6fa8ff", 2.2, 7, 9, [6, -1, 2]); // blue fill, right
  panel("#8b5cff", 2.0, 12, 5, [0, -6, 0]); // violet floor bounce
  panel("#ffffff", 3.5, 1.6, 10, [3, 3, -6]); // white rim strip behind
  panel("#ffffff", 2.5, 4, 1.2, [-1, 6, 4]); // soft top highlight
  panel("#ff9ad5", 1.2, 5, 5, [-5, -3, -5]); // faint rose
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.03).texture;
  pmrem.dispose();
  return env;
}

export default function Blob() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      return; // no WebGL: the CSS orb underneath stays visible
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    camera.position.set(0, 0, 6.2);

    const material = new THREE.MeshPhysicalMaterial({
      color: "#45358f",
      metalness: 0.72,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      iridescence: 1,
      iridescenceIOR: 1.7,
      iridescenceThicknessRange: [120, 1100],
      envMap: studio(renderer),
      envMapIntensity: 1.3,
    });
    const uniforms = { uTime: { value: 0 } };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${NOISE}`)
        // Displace, then rebuild the normal from two nearby displaced points.
        .replace(
          "#include <beginnormal_vertex>",
          `vec3 bp=warp(position);
           vec3 tg=normalize(cross(normal,abs(normal.y)<.99?vec3(0.,1.,0.):vec3(1.,0.,0.)));
           vec3 bt=cross(normal,tg);
           vec3 objectNormal=normalize(cross(warp(position+tg*.01)-bp,warp(position+bt*.01)-bp));
           #ifdef USE_TANGENT
           vec3 objectTangent=vec3(tangent.xyz);
           #endif`,
        )
        .replace("#include <begin_vertex>", "vec3 transformed=bp;");
    };
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 48), material);
    scene.add(mesh);

    // Soft violet rim from behind-left plus a warm key, on top of the env reflections.
    const rim = new THREE.DirectionalLight("#b99cff", 2.2);
    rim.position.set(-3, 2, -4);
    const key = new THREE.DirectionalLight("#ffe2b0", 0.9);
    key.position.set(3, 4, 5);
    scene.add(rim, key);

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ro = new ResizeObserver(() => {
      resize();
      if (still) renderer.render(scene, camera);
    });
    ro.observe(el);
    resize();

    let raf = 0;
    let visible = true;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      uniforms.uTime.value = t;
      mesh.rotation.y = t * 0.08;
      mesh.rotation.x = Math.sin(t * 0.2) * 0.15;
      renderer.render(scene, camera);
      raf = visible ? requestAnimationFrame(tick) : 0;
    };
    // Stop rendering while the hero is scrolled away.
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf && !still) raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    if (still) {
      uniforms.uTime.value = 4;
      renderer.render(scene, camera);
    } else raf = requestAnimationFrame(tick);
    requestAnimationFrame(() => el.classList.add("ready"));

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      mesh.geometry.dispose();
      material.envMap?.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={host} className="blob-canvas" aria-hidden="true" />;
}
