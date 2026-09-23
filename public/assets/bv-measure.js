/* ============================================================
   BETTERVISION — BV-Measure 엔진 v0.3 (09.24 OS 배포본: QC 실패 시 오류 안내 중복 제거)
   단일 엔진 / 3진입점(phone·ipad·rig) 구조.
   설계서: BV_측정시스템_설계서_v0.3.md

   내보내는 전역:
     window.bvFaceMeasure(onDone,onErr,onStat[,opts])  ← 하위호환(기존 customer.html)
     window.BVMeasure = { measure, submit, __ready }    ← v0.3 정식 인터페이스
     window.__bvFaceReady                                ← 모델 로딩 여부

   원칙(설계서 §4):
     ① 영상/프레임 업로드 금지 — 수치+메타만 전송
     ② confidence < 0.7 → provisional 플래그
     ③ 저장 성공 시 customers.size/pd 캐시 갱신 + 타임라인 append (서버 책임)
   ============================================================ */
(function () {
  "use strict";

  var MP_VER = "0.10.3";
  var MP_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + MP_VER;
  var MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  var IRIS_MM = 11.7; // 홍채 지름 기준 픽셀→mm 환산(RGB 단독 스케일)

  // ---- QC 게이트 임계 (설계서 §3 단계2) ----
  var QC = {
    yawMax: 5, // deg
    pitchMax: 5, // deg
    minSamples: 12, // 이보다 적으면 신뢰 불가
    irisPxMin: 6, // 홍채가 너무 작으면(멀거나 저해상) 반려
    faceWidthMin: 110, // mm, 상식 범위
    faceWidthMax: 175,
    pdMin: 48, // mm
    pdMax: 80
  };

  // ---- confidence 임계 (설계서 §4 원칙②) ----
  var CONF_PROVISIONAL = 0.7;

  var landmarker = null;
  window.__bvFaceReady = false;

  var FaceLandmarker, FilesetResolver;

  // 모델 지연 로딩 (첫 measure 호출 시 1회)
  function ensureModel() {
    if (landmarker) return Promise.resolve(true);
    return import(MP_BASE)
      .then(function (mod) {
        FaceLandmarker = mod.FaceLandmarker;
        FilesetResolver = mod.FilesetResolver;
        return FilesetResolver.forVisionTasks(MP_BASE + "/wasm");
      })
      .then(function (fs) {
        return FaceLandmarker.createFromOptions(fs, {
          baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          numFaces: 1
        });
      })
      .then(function (lm) {
        landmarker = lm;
        window.__bvFaceReady = true;
        return true;
      })
      .catch(function (e) {
        window.__bvFaceReady = false;
        console.warn("[BVMeasure] model init fail", e);
        return false;
      });
  }
  // 페이지 로드 직후 백그라운드 프리로드(선택) — 실패해도 조용히
  ensureModel();

  function D(a, b, W, H) {
    return Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
  }

  // 랜드마크로 yaw/pitch 근사 (좌우 눈꼬리 & 코끝 기반, 데모 수준 근사치)
  function estimatePose(L, W, H) {
    // 234=좌 관자, 454=우 관자, 1=코끝, 10=이마, 152=턱
    var lx = L[234].x * W,
      rx = L[454].x * W,
      cx = L[1].x * W;
    var half = (rx - lx) / 2;
    var mid = lx + half;
    var yaw = half > 0 ? ((cx - mid) / half) * 45 : 90; // 코가 중앙에서 벗어난 정도
    var ty = L[10].y * H,
      by = L[152].y * H,
      ny = L[1].y * H;
    var vspan = by - ty;
    var pitch = vspan > 0 ? ((ny - (ty + vspan * 0.5)) / vspan) * 40 : 90;
    return { yaw: Math.abs(yaw), pitch: Math.abs(pitch) };
  }

  function med(a) {
    a.sort(function (x, y) {
      return x - y;
    });
    return a[Math.floor(a.length / 2)];
  }
  function stdev(a, m) {
    if (a.length < 2) return 0;
    var s = a.reduce(function (t, v) {
      return t + (v - m) * (v - m);
    }, 0);
    return Math.sqrt(s / (a.length - 1));
  }

  /* confidence 산출: 표본수·홍채크기·자세·반복편차를 0~1로 종합 */
  function scoreConfidence(ctx) {
    var s = 1.0;
    // 표본수: 12개=0.5, 30+개=1.0
    s *= Math.min(1, Math.max(0.4, ctx.n / 30));
    // 홍채 픽셀(해상도 대리): 6px=하한, 14px+=만점
    s *= Math.min(1, Math.max(0.5, ctx.irisPx / 14));
    // 자세 벌점
    if (ctx.yaw > QC.yawMax) s *= 0.6;
    if (ctx.pitch > QC.pitchMax) s *= 0.6;
    // 반복 편차(PD std): 0.5mm 이하 만점, 2mm 이상 강한 벌점
    var pen = Math.min(1, ctx.pdStd / 2);
    s *= 1 - pen * 0.5;
    // 방식별 상한: RGB 홍채환산은 절대 신뢰 상한을 둠
    if (ctx.method === "iris_scale") s = Math.min(s, 0.85);
    return Math.round(s * 100) / 100;
  }

  /* 결과 스키마 v0.3 — 측정치가 없으면 null(측면 미측정 등) */
  function emptyResult(method, device) {
    return {
      pd: null,
      face_width: null,
      nose_height: null,
      nose_angle: null,
      ear_left: null,
      ear_right: null,
      wrap_angle: null,
      pow: null, // Position of Wear 7요소 (리그/정밀에서만)
      confidence: 0,
      method: method || "iris_scale", // truedepth | iris_scale | rig_stereo
      device: device || "phone", // phone | ipad | rig
      provisional: true,
      qc: { passed: false, reasons: [] }
    };
  }

  /* ---------------- 핵심 측정 (RGB/웹캠 · MediaPipe) ---------------- */
  function measureWebcam(opts, onDone, onErr, onStat) {
    opts = opts || {};
    var device = opts.device || "phone";
    // TrueDepth 경로는 별도 브릿지에서 주입(iOS). 여기선 RGB 홍채환산.
    var method = "iris_scale";

    ensureModel().then(function (ok) {
      if (!ok || !landmarker) {
        onErr && onErr("모델 로딩 전이에요. 잠시 후 다시.");
        return;
      }
      var stream;
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } })
        .then(function (s) {
          stream = s;
          var vid = document.getElementById("camVid");
          vid.srcObject = stream;
          vid.style.display = "block";
          vid.play().catch(function () {});
          onStat && onStat("얼굴을 화면 중앙에 맞춰주세요…");

          var samples = [];
          var poseBad = 0;
          var lastIris = 0;
          var lastPose = { yaw: 0, pitch: 0 };
          var t0 = performance.now();

          function loop() {
            var now = performance.now();
            var W = vid.videoWidth || 640,
              H = vid.videoHeight || 480;
            var r = null;
            try {
              r = landmarker.detectForVideo(vid, now);
            } catch (e) {}
            if (r && r.faceLandmarks && r.faceLandmarks[0]) {
              var L = r.faceLandmarks[0];
              var irisPx = D(L[469], L[471], W, H);
              var pdPx = D(L[468], L[473], W, H);
              var fwPx = D(L[234], L[454], W, H);
              var pose = estimatePose(L, W, H);
              lastIris = irisPx;
              lastPose = pose;
              // QC: 자세 통과한 프레임만 채집
              var poseOk = pose.yaw <= QC.yawMax && pose.pitch <= QC.pitchMax;
              if (irisPx > QC.irisPxMin && poseOk) {
                var sc = IRIS_MM / irisPx;
                samples.push({ pd: pdPx * sc, fw: fwPx * sc });
              } else if (!poseOk) {
                poseBad++;
              }
              onStat &&
                onStat(
                  "측정 중… " +
                    samples.length +
                    (poseOk ? "" : " · 정면을 봐주세요")
                );
            }
            if (now - t0 < 3000 && samples.length < 45) {
              requestAnimationFrame(loop);
            } else {
              finish();
            }
          }

          function finish() {
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
            var vid2 = document.getElementById("camVid");
            vid2.style.display = "none";
            vid2.srcObject = null;

            var out = emptyResult(method, device);
            var reasons = [];

            // ---- QC 게이트 판정 (설계서 §3 단계2) ----
            if (samples.length < QC.minSamples) reasons.push("표본 부족");
            if (lastIris <= QC.irisPxMin) reasons.push("얼굴 인식 약함");
            if (lastPose.yaw > QC.yawMax || lastPose.pitch > QC.pitchMax)
              reasons.push("자세 기울음");

            if (samples.length < QC.minSamples) {
              out.qc = { passed: false, reasons: reasons };
              onErr && onErr("정면·조명을 확인하고 다시 측정해 주세요.");
              onDone && onDone(out); // 실패도 결과 객체로 반환(로깅용, 저장은 안 함)
              return;
            }

            var pdArr = samples.map(function (s) {
              return s.pd;
            });
            var fwArr = samples.map(function (s) {
              return s.fw;
            });
            var pd = med(pdArr.slice());
            var fw = med(fwArr.slice());
            var pdStd = stdev(pdArr, pd);

            // 상식 범위 벗어나면 반려
            if (pd < QC.pdMin || pd > QC.pdMax) reasons.push("PD 범위 이상");
            if (fw < QC.faceWidthMin || fw > QC.faceWidthMax)
              reasons.push("안면폭 범위 이상");

            var conf = scoreConfidence({
              n: samples.length,
              irisPx: lastIris,
              yaw: lastPose.yaw,
              pitch: lastPose.pitch,
              pdStd: pdStd,
              method: method
            });

            out.pd = Math.round(pd * 10) / 10;
            out.face_width = Math.round(fw);
            // 정면 RGB로는 귀 위치·랩각·코 각도 확정 불가 → null 유지(측면/리그에서 채움)
            out.confidence = reasons.length ? Math.min(conf, 0.5) : conf;
            out.provisional = out.confidence < CONF_PROVISIONAL;
            out.qc = { passed: reasons.length === 0, reasons: reasons };
            out.pd_std = Math.round(pdStd * 100) / 100;

            onStat &&
              onStat(
                "측정 완료 · PD " +
                  out.pd +
                  "mm · 신뢰도 " +
                  Math.round(out.confidence * 100) +
                  "%" +
                  (out.provisional ? " (임시)" : "")
              );
            onDone && onDone(out);
          }

          requestAnimationFrame(loop);
        })
        .catch(function () {
          onErr && onErr("카메라 권한이 필요해요.");
        });
    });
  }

  /* ---------------- 서버 제출 (설계서 §4 API) ---------------- */
  function submit(customerId, result, meta) {
    meta = meta || {};
    // 영상/프레임은 애초에 result에 없음 — 수치+메타만.
    var body = {
      customer_id: customerId,
      device: result.device,
      method: result.method,
      pd: result.pd,
      face_width: result.face_width,
      nose_height: result.nose_height,
      nose_angle: result.nose_angle,
      ear_left: result.ear_left,
      ear_right: result.ear_right,
      wrap_angle: result.wrap_angle,
      pow: result.pow,
      confidence: result.confidence,
      provisional: result.provisional,
      store: meta.store || null,
      operator: meta.operator || null,
      session_id: meta.session_id || null
    };
    return fetch("/api/measure/sessions/" + (meta.session_id || "adhoc") + "/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.ok ? r.json() : Promise.reject(r.status);
    });
  }

  /* ---------------- 정식 인터페이스 ---------------- */
  window.BVMeasure = {
    __ready: function () {
      return !!window.__bvFaceReady;
    },
    measure: measureWebcam, // (opts, onDone, onErr, onStat)
    submit: submit
  };

  /* ---------------- 하위호환 shim (기존 customer.html) ----------------
     기존 코드는 onDone에 {pd, faceWidth}만 기대. 스키마를 축약해 전달하되
     내부적으로는 v0.3 result를 window.__bvLastResult에 보관. */
  window.bvFaceMeasure = function (onDone, onErr, onStat, opts) {
    measureWebcam(
      opts || {},
      function (res) {
        window.__bvLastResult = res;
        if (res.qc && res.qc.passed === false && res.face_width == null) {
          // QC 실패: measureWebcam이 이미 onErr를 불렀으므로 여기서는 다시 부르지 않는다 (09.24, 안내 두 번 뜨던 문제)
          return;
        }
        onDone &&
          onDone({
            pd: res.pd,
            faceWidth: res.face_width,
            confidence: res.confidence,
            provisional: res.provisional
          });
      },
      onErr,
      onStat
    );
  };
})();
