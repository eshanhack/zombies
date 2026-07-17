import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CONFIG } from '../config.js';

const productionShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDamage: { value: 0 },
    uGrain: { value: CONFIG.rendering.post.grainStrength },
    uVignette: { value: CONFIG.rendering.post.vignetteStrength },
    uDesaturation: { value: CONFIG.rendering.post.desaturation },
    uContrast: { value: CONFIG.rendering.post.contrast },
    uLift: { value: CONFIG.rendering.post.lift },
    uChromatic: { value: CONFIG.rendering.post.chromaticAberrationPx },
    uScratch: { value: CONFIG.rendering.post.scratchStrength },
    uDamageDesaturation: { value: CONFIG.rendering.post.damageDesaturation },
    uBloomStrength: { value: CONFIG.rendering.post.bloomStrength },
    uBloomThreshold: { value: CONFIG.rendering.post.bloomThreshold },
    uBloomRadius: { value: CONFIG.rendering.post.bloomRadius },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uDamage;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uDesaturation;
    uniform float uContrast;
    uniform float uLift;
    uniform float uChromatic;
    uniform float uScratch;
    uniform float uDamageDesaturation;
    uniform float uBloomStrength;
    uniform float uBloomThreshold;
    uniform float uBloomRadius;
    varying vec2 vUv;

    float hash(vec2 value) {
      vec3 p3 = fract(vec3(value.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 centered = vUv - 0.5;
      vec2 chromaOffset = centered * (uChromatic / max(uResolution.x, uResolution.y));
      vec3 color;
      color.r = texture2D(tDiffuse, vUv + chromaOffset).r;
      color.g = texture2D(tDiffuse, vUv).g;
      color.b = texture2D(tDiffuse, vUv - chromaOffset).b;

      vec2 bloomTexel = mix(1.0, 3.2, uBloomRadius) / uResolution;
      vec3 bloom = texture2D(tDiffuse, vUv + vec2(bloomTexel.x, 0.0)).rgb;
      bloom += texture2D(tDiffuse, vUv - vec2(bloomTexel.x, 0.0)).rgb;
      bloom += texture2D(tDiffuse, vUv + vec2(0.0, bloomTexel.y)).rgb;
      bloom += texture2D(tDiffuse, vUv - vec2(0.0, bloomTexel.y)).rgb;
      bloom *= 0.25;
      float bloomMask = smoothstep(uBloomThreshold, 1.0, max(bloom.r, max(bloom.g, bloom.b)));
      color += bloom * bloomMask * uBloomStrength;

      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float desaturation = clamp(uDesaturation + uDamage * uDamageDesaturation, 0.0, 1.0);
      color = mix(color, vec3(luminance), desaturation);
      color = (color - 0.5) * uContrast + 0.5 + uLift;
      color *= vec3(0.975, 0.992, 1.018);

      float radius = dot(centered, centered) * 2.0;
      float vignette = smoothstep(0.12, 1.05, radius) * uVignette;
      color *= 1.0 - vignette;

      float frameNoise = hash(gl_FragCoord.xy + vec2(uTime * 91.7, uTime * 47.3)) - 0.5;
      color += frameNoise * uGrain;
      float scratchColumn = step(0.996, hash(vec2(floor(vUv.x * uResolution.x * 0.16), floor(uTime * 8.0))));
      float scratchGate = step(0.77, hash(vec2(floor(uTime * 1.7), 12.3)));
      color += scratchColumn * scratchGate * uScratch * (0.35 + 0.65 * sin(vUv.y * 83.0 + uTime));

      float damageEdge = smoothstep(0.16, 0.92, radius) * uDamage;
      color = mix(color, color * vec3(0.42, 0.06, 0.045), damageEdge * 0.46);
      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

export class ProductionPost {
  readonly composer: EffectComposer;
  private readonly grade: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.grade = new ShaderPass(productionShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, CONFIG.rendering.maxPixelRatio));
  }

  render(elapsedSeconds: number, healthRatio: number): void {
    this.grade.uniforms.uTime!.value = elapsedSeconds;
    this.grade.uniforms.uDamage!.value = THREE.MathUtils.smoothstep(1 - healthRatio, 0.5, 1);
    this.composer.render();
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    (this.grade.uniforms.uResolution!.value as THREE.Vector2).set(width * pixelRatio, height * pixelRatio);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
