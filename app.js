/* ===========================================================
   FLOWER BLOOM — Real-time Hand Gesture Flower Controller
   ===========================================================
   Uses MediaPipe Hands to track hand gestures and render a
   procedural glowing flower that blooms, grows, and sways
   with wind — all on a Canvas overlay atop the webcam feed.
   =========================================================== */

// =============================================================
// NOISE — Organic movement via layered sine waves
// =============================================================
class OrganicNoise {
    constructor() {
        this.seeds = Array.from({ length: 8 }, () => Math.random() * 1000);
    }

    /** Returns a value roughly in [-1, 1] */
    get(t, channel = 0) {
        const s = this.seeds[channel % this.seeds.length];
        return (
            Math.sin(t * 0.7 + s) * 0.4 +
            Math.sin(t * 1.3 + s * 1.7) * 0.3 +
            Math.sin(t * 2.1 + s * 0.3) * 0.2 +
            Math.sin(t * 3.7 + s * 2.1) * 0.1
        );
    }
}

// =============================================================
// PARTICLE — Floating pollen / sparkle
// =============================================================
class Particle {
    constructor(cw, ch) {
        this.cw = cw;
        this.ch = ch;
        this.reset(true);
    }

    reset(initial = false) {
        this.x = Math.random() * this.cw;
        this.y = initial ? Math.random() * this.ch : this.ch + Math.random() * 40;
        this.radius = Math.random() * 2.5 + 0.5;
        this.vx = (Math.random() - 0.5) * 0.3;
        this.vy = -(Math.random() * 0.6 + 0.15);
        this.life = Math.random() * 300 + 150;
        this.maxLife = this.life;
        this.hue = 330 + Math.random() * 40;          // pink-ish
        this.brightness = 70 + Math.random() * 20;
        this.flickerPhase = Math.random() * Math.PI * 2;
    }

    update(windForce, dt) {
        this.x += this.vx + windForce * 1.8;
        this.y += this.vy;
        this.life -= dt;
        if (this.life <= 0 || this.y < -20 || this.x < -20 || this.x > this.cw + 20) {
            this.reset();
        }
    }

    draw(ctx) {
        const t = this.life / this.maxLife;
        const flicker = 0.5 + 0.5 * Math.sin(this.life * 0.08 + this.flickerPhase);
        const alpha = t * 0.75 * flicker;
        if (alpha < 0.02) return;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 12;
        ctx.shadowColor = `hsla(${this.hue}, 100%, ${this.brightness}%, 0.8)`;
        ctx.fillStyle = `hsla(${this.hue}, 90%, ${this.brightness}%, 1)`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// =============================================================
// MAIN APPLICATION
// =============================================================
class FlowerBloomApp {
    constructor() {
        // DOM
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.video = document.getElementById('webcam');
        this.loadingEl = document.getElementById('loading');
        this.instructionsEl = document.getElementById('instructions');

        // Noise
        this.noise = new OrganicNoise();

        // Time
        this.time = 0;
        this.lastTimestamp = 0;

        // Gesture state (smoothed values)
        this.bloom = 0;
        this.growth = 0;
        this.windForce = 0;

        // Gesture targets (raw from detection)
        this.targetBloom = 0;
        this.targetGrowth = 0;
        this.targetWindForce = 0;

        // Previous hand X for velocity-based wind
        this.prevHandX = 0.5;

        // Hand landmarks (updated each frame by MediaPipe)
        this.handLandmarks = [];
        this.handHandedness = [];
        this.handsDetected = 0;

        // Particles
        this.particles = [];

        // Setup
        this.resize();
        window.addEventListener('resize', () => this.resize());

        this.initParticles();
        this.initHandTracking();

        // Hide instructions after 8 seconds
        setTimeout(() => {
            this.instructionsEl?.classList.add('hidden');
        }, 8000);

        // Kick off render
        requestAnimationFrame((ts) => this.animate(ts));
    }

    // ---------------------------------------------------------
    // Setup
    // ---------------------------------------------------------
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;

        // Re-bound particles
        for (const p of this.particles) {
            p.cw = this.canvas.width;
            p.ch = this.canvas.height;
        }
    }

    initParticles() {
        const count = 60;
        for (let i = 0; i < count; i++) {
            this.particles.push(new Particle(this.canvas.width, this.canvas.height));
        }
    }

    initHandTracking() {
        const hands = new Hands({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
        });

        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.65,
            minTrackingConfidence: 0.5,
        });

        hands.onResults((r) => this.onHandResults(r));

        const cam = new Camera(this.video, {
            onFrame: async () => {
                await hands.send({ image: this.video });
            },
            width: 1280,
            height: 720,
        });

        cam.start().then(() => {
            setTimeout(() => this.loadingEl?.classList.add('hidden'), 600);
        });
    }

    // ---------------------------------------------------------
    // Hand results callback
    // ---------------------------------------------------------
    onHandResults(results) {
        this.handLandmarks = results.multiHandLandmarks || [];
        this.handHandedness = results.multiHandedness || [];
        this.handsDetected = this.handLandmarks.length;

        let leftPinch = 0;
        let rightPinch = 0;
        let hasLeft = false;
        let hasRight = false;

        if (this.handsDetected > 0) {
            for (let i = 0; i < this.handsDetected; i++) {
                const hand = this.handLandmarks[i];
                const handedness = results.multiHandedness[i];
                // MediaPipe handedness label is 'Left' or 'Right'
                const isLeft = handedness && handedness.label === 'Left';
                const pinch = this.calcPinchDistance(hand);

                if (isLeft) {
                    leftPinch = pinch;
                    hasLeft = true;
                } else {
                    rightPinch = pinch;
                    hasRight = true;
                }

                // Wind from hand horizontal velocity
                const c = this.palmCenter(hand);
                const dx = c.x - this.prevHandX;
                this.targetWindForce = dx * 12;
                this.prevHandX = c.x;
            }

            // Left hand controls Bloom
            this.targetBloom = hasLeft ? leftPinch : 0;

            // Right hand controls Growth
            this.targetGrowth = hasRight ? rightPinch : 0;
        } else {
            // No hands → slowly close and shrink back to 0
            this.targetBloom *= 0.94;
            this.targetGrowth *= 0.94;
            this.targetWindForce *= 0.9;
        }
    }

    /**
     * Pinch distance: distance between thumb tip (4) and index fingertip (8),
     * normalized by hand size so it works at any distance from the camera.
     * Returns 0 (pinched) → 1 (fully spread).
     */
    calcPinchDistance(lm) {
        const thumb = lm[4];   // thumb tip
        const index = lm[8];   // index fingertip
        const wrist = lm[0];
        const mcp = lm[9];     // middle-finger MCP

        // Reference = wrist-to-MCP distance (scales with hand size in frame)
        const ref = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y);
        if (ref < 0.01) return 0;

        const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        // Normalize: pinch ~0 when touching, ~1 when spread wide
        return Math.min(1, Math.max(0, (dist / ref - 0.15) * 1.6));
