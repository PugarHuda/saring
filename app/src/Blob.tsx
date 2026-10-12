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
  // Low-frequency, slow: a drop of liquid breathing, not a lumpy rock.
  float n=snoise(p*.48+vec3(uTime*.11,uTime*.07,0.))*.2+snoise(p*.95-uTime*.05)*.045;
  return p+normalize(p)*n;
}`;

// Smooth HDR light dome baked into a PMREM env map. Gradients (not hard panels) so the
// reflections read as liquid metal instead of colour patches. The camera looks down -z,
// so the blob's centre reflects +z (kept dark indigo) and its silhouette reflects -z (gold).
const DOME = /* glsl */ `
varying vec3 vDir;
float lobe(vec3 d, vec3 c, float k){ return exp((dot(d, normalize(c)) - 1.) * k); }
void main(){
  vec3 d = normalize(vDir);
  vec3 col = vec3(.004, .003, .014);
  col += vec3(.03, .05, .4)  * lobe(d, vec3(.6, -.15, .75), 4.) * 1.;     // deep indigo, front right
  col += vec3(.1, .22, 1.)   * lobe(d, vec3(1., .3, -.2), 14.) * 2.5;    // blue edge, right
  col += vec3(.35, .1, .9)   * lobe(d, vec3(.1, -1., .1), 6.) * 1.3;     // violet floor bounce
  float back = smoothstep(.1, -.6, d.z);
  col += vec3(1., .48, .1) * back * (.25 + .9 * smoothstep(.22, .0, abs(d.y - .12)));   // molten gold horizon behind
  col += vec3(1., .55, .15) * lobe(d, vec3(-.7, .55, -.35), 26.) * 6.;    // gold key, upper left
  col += vec3(1., .97, .92)  * lobe(d, vec3(-.55, -.55, -.7), 48.) * 26.; // white rim, lower left
  col += vec3(1.)            * lobe(d, vec3(-.3, .85, .45), 140.) * 14.; // small hot specular
  col += vec3(1., .7, .35)   * lobe(d, vec3(.6, .7, -.35), 50.) * 5.;    // warm glint, upper right
  gl_FragColor = vec4(col, 1.);
}`;

function studio(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10, 64, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: "varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }",
      fragmentShader: DOME,
    }),
  );
  scene.add(dome);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.01).texture;
  pmrem.dispose();
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
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
    renderer.toneMappingExposure = 0.9;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    camera.position.set(0, 0, 6.2);

    const material = new THREE.MeshPhysicalMaterial({
      color: "#d8d2f0",
      metalness: 1,
      roughness: 0.035,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      // Thin, low-strength film: a hint of chromatic dispersion, not rainbow splotches.
      iridescence: 0.35,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [180, 420],
      envMap: studio(renderer),
      envMapIntensity: 1,
    });
    const uniforms = { uTime: { value: 0 } };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      // Fresnel rim: gold around the silhouette, going white-hot toward the lower left.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `float fr = pow(1. - saturate(dot(normal, geometryViewDir)), 3.5);
         float ll = saturate(dot(normalize(normal.xy + 1e-4), normalize(vec2(-.75, -.65))));
         outgoingLight += mix(vec3(1., .5, .12) * .35, vec3(1., .95, .88) * 1.2, pow(ll, 4.)) * fr;
         #include <opaque_fragment>`,
      );
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${NOISE}`)
        // Displace, then rebuild the normal from two nearby displaced points.
        .replace(
          "#include <beginnormal_vertex>",
          `vec3 bp=warp(position);
           vec3 tg=normalize(cross(normal,abs(normal.y)<.99?vec3(0.,1.,0.):vec3(1.,0.,0.)));
           vec3 bt=cross(normal,tg);
           vec3 objectNormal=normalize(cross(warp(position+tg*.03)-bp,warp(position+bt*.03)-bp));
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
