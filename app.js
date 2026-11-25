// ==========================================================================
// IELTS READING TINH GỌN — INTERACTIVE STUDENT APPLICATION ENGINE
// Design & UX inspired by VSTEP Speaking (Soft Neo-Brutalist Studio)
// ==========================================================================

(function () {
  const THEORY = window.READING_THEORY;
  const GUIDES = window.READING_GUIDES;
  const EXERCISES = window.READING_EXERCISES || [];
  const WRITING_UNITS = window.WRITING_UNITS || [];
  const CLOUD = window.ReadingCloud || null;
  const STORAGE_KEY = "ielts_reading_tinh_gon_v1";

  let currentAccount = null; // { id, name, email } when authenticated via Supabase (same project as ielts-listening)

  const cloudState = {
    isTeacher: false,
    submissionsByLessonId: {}, // unit.id -> writing_submissions row
    reviewsByLessonId: {},     // unit.id -> writing_ai_reviews row
    submittingUnitId: "",
    submitErrorByUnitId: {},
    notifPollTimer: null,
    lastReviewsRefreshMs: 0,
    reviewsRefreshInFlight: false
  };

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function getInitials(name) {
    const parts = String(name || "TK").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "TK";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function countWords(text) {
    const clean = String(text || "").trim();
    if (!clean) return 0;
    return clean.split(/\s+/).filter(Boolean).length;
  }

  function normalizeAnswer(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:'"()]/g, "")
      .replace(/\s+/g, " ");
  }

  function normalizeWritingSentence(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/[.,!?]+/g, "")
      .replace(/\s+/g, " ");
  }

  function speakEnglishText(rawText, rate, accent) {
    const cleanText = String(rawText || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanText) return;
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(cleanText);
        const lang = accent === "UK" ? "en-GB" : "en-US";
        utter.lang = lang;
        utter.rate = rate || 0.9;
        const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
        const matched = voices.find(v => v.lang && v.lang.toLowerCase().startsWith(lang.toLowerCase()));
        if (matched) utter.voice = matched;
        window.speechSynthesis.speak(utter);
      } catch (e) {}
    }
  }

  function stopSpeech() {
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }
  }

  // --------------------------------------------------------------------------
  // LOCAL STORAGE PERSONAL WORKSPACE ENGINE
  // --------------------------------------------------------------------------
  function createDefaultProfile(overrides) {
    const base = overrides || {};
    const rawName = String(base.name || "").trim();
    const cleanName = rawName && rawName !== "Học viên IELTS" ? rawName : "Tài khoản";
    return {
      name: cleanName,
      createdAt: base.createdAt || new Date().toISOString(),
      lastActiveAt: base.lastActiveAt || new Date().toISOString(),
      savedVocab: Array.isArray(base.savedVocab)
        ? base.savedVocab
        : [
            {
              word: "cost less to produce ↔ cheaper to manufacture",
              ipa: "/ˌmænjuˈfæktʃər/",
              pos: "paraphrase",
              meaning: "chi phí sản xuất rẻ hơn",
              example: "Plastic caps are cheaper to manufacture than cork.",
              topic: "Gap-filling · Mẫu"
            },
            {
              word: "in isolation ↔ completely alone",
              ipa: "/ˌaɪsəˈleɪʃn/",
              pos: "paraphrase",
              meaning: "ở một mình / tách biệt",
              example: "People seldom laugh when they are in isolation.",
              topic: "Gap-filling · Mẫu"
            }
          ],
      theoryQuiz: base.theoryQuiz || { answers: {}, submitted: false, score: 0 },
      exercises: base.exercises || {},
      writingProgress: base.writingProgress || {},
      notifications: Array.isArray(base.notifications)
        ? base.notifications
        : [
            {
              id: "welcome-1",
              title: "Chào mừng tới IELTS Reading & Writing!",
              sub: "Chọn kỹ năng Reading hoặc Writing để bắt đầu luyện tập ngay.",
              time: formatDateTime(new Date().toISOString()),
              read: false,
              actionView: "home"
            }
          ]
    };
  }

  function createDefaultStore() {
    return { profile: createDefaultProfile() };
  }

  function getStorageKeyForActiveUser() {
    if (currentAccount && currentAccount.id) {
      return `${STORAGE_KEY}__${currentAccount.id}`;
    }
    return STORAGE_KEY;
  }

  function loadStore() {
    const key = getStorageKeyForActiveUser();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.profile) {
          return { profile: createDefaultProfile(parsed.profile) };
        }
        // Migrate legacy multi-student data into single profile without classes/students
        if (parsed && parsed.students && Object.keys(parsed.students).length > 0) {
          const active =
            (parsed.activeStudentId && parsed.students[parsed.activeStudentId]) ||
            Object.values(parsed.students)[0];
          const migrated = { profile: createDefaultProfile(active) };
          saveStore(migrated);
          return migrated;
        }
      }
      // If user logs in for the first time on Reading, check if legacy default progress exists
      if (key !== STORAGE_KEY) {
        const legacyRaw = localStorage.getItem(STORAGE_KEY);
        if (legacyRaw) {
          const legacyParsed = JSON.parse(legacyRaw);
          if (legacyParsed && legacyParsed.profile) {
            const migrated = {
              profile: createDefaultProfile({
                ...legacyParsed.profile,
                name: (currentAccount && currentAccount.name) || legacyParsed.profile.name
              })
            };
            saveStore(migrated);
            return migrated;
          }
        }
      }
    } catch (e) {}
    const fresh = createDefaultStore();
    if (currentAccount && currentAccount.name) {
      fresh.profile.name = currentAccount.name;
    }
    saveStore(fresh);
    return fresh;
  }

  function saveStore(nextStore) {
    try {
      localStorage.setItem(getStorageKeyForActiveUser(), JSON.stringify(nextStore));
    } catch (e) {}
  }

  let store = loadStore();

  function reloadStoreForAccount() {
    store = loadStore();
    if (currentAccount && currentAccount.name) {
      store.profile.name = currentAccount.name;
      saveStore(store);
    }
  }

  function getActiveStudent() {
    if (!store || !store.profile) {
      store = createDefaultStore();
      saveStore(store);
    }
    const stu = store.profile;
    if (!stu.exercises) stu.exercises = {};
    if (!stu.writingProgress) stu.writingProgress = {};
    if (!stu.savedVocab) stu.savedVocab = [];
    if (!stu.theoryQuiz) stu.theoryQuiz = { answers: {}, submitted: false, score: 0 };
    if (!stu.notifications) stu.notifications = [];
    return stu;
  }

  function persist() {
    const stu = getActiveStudent();
    stu.lastActiveAt = new Date().toISOString();
    saveStore(store);
  }

  function ensureExerciseState(exId) {
    const stu = getActiveStudent();
    if (!stu.exercises[exId]) {
      stu.exercises[exId] = {
        answers: {},
        submitted: false,
        score: 0,
        total: 0,
        submittedAt: "",
        ideaNote: "",
        highlightedSentences: {},
        textHighlights: {}
      };
    }
    return stu.exercises[exId];
  }

  function ensureWritingUnitProgress(unitId) {
    const stu = getActiveStudent();
    if (!stu.writingProgress) stu.writingProgress = {};
    if (!stu.writingProgress[unitId]) {
      stu.writingProgress[unitId] = {
        completedSections: [],
        exerciseAnswers: {},
        checkedExercises: {},
        submittedWritings: {}
      };
    }
    const p = stu.writingProgress[unitId];
    if (!Array.isArray(p.completedSections)) p.completedSections = [];
    if (!p.exerciseAnswers) p.exerciseAnswers = {};
    if (!p.checkedExercises) p.checkedExercises = {};
    if (!p.submittedWritings) p.submittedWritings = {};
    return p;
  }

  // --------------------------------------------------------------------------
  // UI STATE
  // --------------------------------------------------------------------------
  let initialSidebarCollapsed = false;
  try {
    initialSidebarCollapsed = localStorage.getItem("ielts_reading_sb_collapsed") === "1";
  } catch (e) {}

  const state = {
    view: "home", // "home" | "reading-hub" | "writing-hub" | "writing-lesson" | "theory" | "part-topics" | "practice" | "my-submissions" | "keyword-hub"
    selectedPart: "gap-filling", // "gap-filling" | "matching-names" | "multiple-choice" | "matching-info"
    prevDashboardView: "home",
    currentExerciseId: EXERCISES[0] ? EXERCISES[0].id : "gf-1",
    currentWritingUnitId: WRITING_UNITS[0] ? WRITING_UNITS[0].id : "wr-unit-1",
    currentWritingSection: "vocabulary", // "vocabulary" | "phrases" | "writing"
    currentWritingPart: "A",
    activeReorderKey: "",
    sidebarCollapsed: initialSidebarCollapsed,
    mobileSidebarOpen: false,
    sbTheoryCollapsed: true,
    sbReadingCollapsed: true,
    sbWritingCollapsed: true,
    sbGapCollapsed: false,
    sbMatchCollapsed: false,
    sbMcqCollapsed: false,
    sbInfoCollapsed: false,
    notifOpen: false,
    accountMenuOpen: false,
    authMode: "login", // "login" | "register"
    authError: "",
    authInfo: "",
    authLoading: false,
    localPreviewMode: false,
    // Practice room interactive helpers
    highlightToolActive: false,
    highlightColor: "yellow", // "yellow" | "green" | "blue" | "pink" | "purple"
    scanHelperActive: false,
    translateModeActive: false,
    revealedTranslations: {},
    activeEvidenceSentenceId: "",
    activeFocusedGapId: "",
    // Worked example toggle in Strategy Banner
    workedExampleShowAnswers: true,
    // Modals
    vocabModalOpen: false,
    vocabModalTab: "list", // "list" | "flashcard"
    vocabSearchQuery: "",
    flashcardIndex: 0,
    flashcardFlipped: false,
    // Keyword Hub view
    kwHubFilter: "all", // "all" | "intro" | "gap-filling" | "matching-names" | "multiple-choice" | "matching-info"
    kwHubSearch: "",
    kwHubFlashcardMode: false,
    kwHubCardIdx: 0,
    kwHubCardFlipped: false
  };

  const PART_META = {
    "gap-filling": {
      code: "D1",
      shortLabel: "Dạng 1",
      title: "Dạng 1: Gap-filling",
      eyebrow: "CHUYÊN ĐỀ 1 · GAP-FILLING"
    },
    "matching-names": {
      code: "D2",
      shortLabel: "Dạng 2",
      title: "Dạng 2: Matching Names",
      eyebrow: "CHUYÊN ĐỀ 2 · MATCHING NAMES"
    },
    "multiple-choice": {
      code: "D3",
      shortLabel: "Dạng 3",
      title: "Dạng 3: Multiple Choice",
      eyebrow: "CHUYÊN ĐỀ 3 · MULTIPLE CHOICE"
    },
    "matching-info": {
      code: "D4",
      shortLabel: "Dạng 4",
      title: "Dạng 4: Matching Information",
      eyebrow: "CHUYÊN ĐỀ 4 · WHICH PARAGRAPH CONTAINS"
    }
  };

  const HIGHLIGHT_COLORS = [
    { key: "yellow", label: "Vàng pastel", bg: "#FEF08A", soft: "#FEF3C7" },
    { key: "green", label: "Xanh lá pastel", bg: "#BBF7D0", soft: "#DCFCE7" },
    { key: "blue", label: "Xanh dương pastel", bg: "#BAE6FD", soft: "#E0F2FE" },
    { key: "pink", label: "Hồng pastel", bg: "#FBCFE8", soft: "#FCE7F3" },
    { key: "purple", label: "Tím pastel", bg: "#DDD6FE", soft: "#EDE9FE" }
  ];

  function getPartMeta(partId) {
    return PART_META[partId] || PART_META["gap-filling"];
  }

  // --------------------------------------------------------------------------
  // CATALOG & AGGREGATIONS
  // --------------------------------------------------------------------------
  function getExercisesByPart(partId) {
    return EXERCISES.filter(e => e.part === partId);
  }

  function getCurrentExercise() {
    return EXERCISES.find(e => e.id === state.currentExerciseId) || EXERCISES[0];
  }

  function getCompletedExercisesCount() {
    const stu = getActiveStudent();
    return EXERCISES.filter(e => stu.exercises[e.id] && stu.exercises[e.id].submitted).length;
  }

  const WRITING_SECTIONS = [
    { key: "vocabulary", num: "1", label: "Vocabulary", labelVi: "Từ vựng" },
    { key: "phrases", num: "2", label: "Phrases", labelVi: "Cụm từ" },
    { key: "writing", num: "3", label: "Writing", labelVi: "Luyện viết" }
  ];

  function getCurrentWritingUnit() {
    return WRITING_UNITS.find(u => u.id === state.currentWritingUnitId) || WRITING_UNITS[0] || null;
  }

  function getWritingUnitDoneSectionsCount(unitId) {
    const stu = getActiveStudent();
    const p = stu.writingProgress && stu.writingProgress[unitId];
    if (!p || !Array.isArray(p.completedSections)) return 0;
    return WRITING_SECTIONS.filter(s => p.completedSections.includes(s.key)).length;
  }

  function getCompletedWritingUnitsCount() {
    return WRITING_UNITS.filter(u => getWritingUnitDoneSectionsCount(u.id) >= 3).length;
  }

  function getSubmittedWritingEssaysList() {
    const stu = getActiveStudent();
    const mapByUnit = {};

    WRITING_UNITS.forEach(u => {
      const cloudSub = cloudState.submissionsByLessonId[u.id];
      if (cloudSub && cloudSub.is_submitted) {
        mapByUnit[u.id] = {
          unit: u,
          exId: "cloud",
          info: {
            wordCount: cloudSub.word_count || countWords(cloudSub.content || ""),
            text: cloudSub.content || "",
            submittedAt: cloudSub.submitted_at || cloudSub.updated_at || cloudSub.created_at || ""
          },
          cloudSub,
          releasedReview: getReleasedWritingReview(u.id)
        };
        return;
      }

      const p = stu.writingProgress && stu.writingProgress[u.id];
      if (!p || !p.submittedWritings) return;
      Object.entries(p.submittedWritings).forEach(([exId, info]) => {
        if (info && info.submittedAt) {
          mapByUnit[u.id] = {
            unit: u,
            exId,
            info,
            cloudSub: null,
            releasedReview: getReleasedWritingReview(u.id)
          };
        }
      });
    });

    return Object.values(mapByUnit).sort(
      (a, b) => new Date(b.info.submittedAt || 0).getTime() - new Date(a.info.submittedAt || 0).getTime()
    );
  }

  function getCloudWritingSubmission(unitId) {
    return (unitId && cloudState.submissionsByLessonId[unitId]) || null;
  }

  function getReleasedWritingReview(unitId) {
    if (!unitId) return null;
    const rev = cloudState.reviewsByLessonId[unitId];
    if (!rev || rev.status !== "ready" || !rev.review_json) return null;
    const relMs = rev.release_at ? new Date(rev.release_at).getTime() : 0;
    if (!isNaN(relMs) && relMs > Date.now() && !cloudState.isTeacher) return null;
    return rev;
  }

  function getAllReleasedWritingReviews() {
    return Object.keys(cloudState.reviewsByLessonId)
      .map(uid => getReleasedWritingReview(uid))
      .filter(Boolean)
      .sort((a, b) => new Date(b.release_at || b.updated_at || 0).getTime() - new Date(a.release_at || a.updated_at || 0).getTime());
  }

  async function markWritingReviewSeen(unitId) {
    const rev = getReleasedWritingReview(unitId);
    if (!rev || rev.student_seen_at || !CLOUD || state.localPreviewMode) return;
    const client = CLOUD.getClient();
    if (!client) return;
    rev.student_seen_at = new Date().toISOString();
    try {
      await client.rpc("mark_writing_review_seen", { p_submission_id: rev.submission_id });
    } catch (e) {}
  }

  function findPrimaryWritingExercise(unit) {
    if (!unit || !unit.sections || !unit.sections.writing || !unit.sections.writing.parts) return null;
    const parts = Object.values(unit.sections.writing.parts);
    for (let i = 0; i < parts.length; i++) {
      const ex = (parts[i].exercises || []).find(item => item.type === "writing");
      if (ex) return ex;
    }
    return null;
  }

  function hydrateWritingProgressFromCloud() {
    let changed = false;
    WRITING_UNITS.forEach(unit => {
      const sub = cloudState.submissionsByLessonId[unit.id];
      if (!sub || !sub.is_submitted) return;
      const writingEx = findPrimaryWritingExercise(unit);
      if (!writingEx) return;
      const prog = ensureWritingUnitProgress(unit.id);
      const exKey = `writing__${writingEx.id}`;
      const ansKey = `${exKey}_1`;
      if (sub.content && !prog.exerciseAnswers[ansKey]) {
        prog.exerciseAnswers[ansKey] = sub.content;
        changed = true;
      }
      if (!prog.checkedExercises[exKey]) {
        prog.checkedExercises[exKey] = true;
        changed = true;
      }
      if (!prog.completedSections.includes("writing")) {
        prog.completedSections.push("writing");
        changed = true;
      }
      prog.submittedWritings[writingEx.id] = {
        wordCount: sub.word_count || countWords(sub.content || ""),
        text: sub.content || "",
        submittedAt: sub.submitted_at || sub.updated_at || new Date().toISOString()
      };
    });
    if (changed) persist();
  }

  async function refreshCloudWritingReviews(force) {
    const client = CLOUD ? CLOUD.getClient() : null;
    if (!client || !currentAccount || state.localPreviewMode || cloudState.reviewsRefreshInFlight) return;
    const now = Date.now();
    if (!force && now - cloudState.lastReviewsRefreshMs < 10000) return;

    cloudState.reviewsRefreshInFlight = true;
    try {
      const [subsRes, reviewsRes] = await Promise.all([
        client.from("writing_submissions").select("*").eq("user_id", currentAccount.id),
        client.from("writing_ai_reviews").select("*").eq("user_id", currentAccount.id)
      ]);
      cloudState.lastReviewsRefreshMs = Date.now();
      if (Array.isArray(subsRes.data)) {
        const subMap = {};
        subsRes.data.forEach(row => {
          if (row && row.lesson_id) subMap[row.lesson_id] = row;
        });
        cloudState.submissionsByLessonId = subMap;
        hydrateWritingProgressFromCloud();
      }
      if (Array.isArray(reviewsRes.data)) {
        const revMap = {};
        reviewsRes.data.forEach(row => {
          if (row && row.lesson_id) revMap[row.lesson_id] = row;
        });
        cloudState.reviewsByLessonId = revMap;
      }
      renderApp();
    } catch (e) {} finally {
      cloudState.reviewsRefreshInFlight = false;
    }
  }

  function startCloudReviewPolling() {
    if (cloudState.notifPollTimer) {
      clearInterval(cloudState.notifPollTimer);
      cloudState.notifPollTimer = null;
    }
    if (state.localPreviewMode) return;
    cloudState.notifPollTimer = setInterval(() => {
      if (currentAccount && document.visibilityState === "visible") {
        refreshCloudWritingReviews(false);
      }
    }, 60000);
  }

  async function submitWritingEssayToCloud(unit, ex, content, wordCount) {
    const client = CLOUD ? CLOUD.getClient() : null;
    if (!client || !currentAccount || state.localPreviewMode) {
      return { ok: false, skipped: true };
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const defaultReleaseIso = new Date(nowMs + 12 * 60 * 60 * 1000).toISOString();
    const rowId = `${currentAccount.id}__${unit.id}`;
    const existing = getCloudWritingSubmission(unit.id);
    const promptSummary = [ex.instruction, ex.promptBox].filter(Boolean).join("\n\n");

    const payload = {
      id: rowId,
      user_id: currentAccount.id,
      lesson_id: unit.id,
      lesson_title: `Unit ${unit.number}: ${unit.titleEn} (${unit.titleVi})`,
      prompt_text: promptSummary,
      content: content || "",
      word_count: wordCount || 0,
      is_submitted: true,
      submitted_at: nowIso,
      updated_at: nowIso
    };

    const { data, error } = await client
      .from("writing_submissions")
      .upsert(payload, { onConflict: "id" })
      .select("*")
      .maybeSingle();

    if (error) {
      return { ok: false, error: error.message || "Không thể lưu bài lên Supabase." };
    }

    try {
      await client.from("profiles").update({ last_active_at: nowIso }).eq("id", currentAccount.id);
    } catch (e) {}

    // Clear previous cached review on resubmission while awaiting the new 12h correction
    delete cloudState.reviewsByLessonId[unit.id];

    const savedRow = {
      ...(data || payload),
      teacher_feedback: (data && data.teacher_feedback) || (existing ? existing.teacher_feedback : ""),
      ai_status: "scheduled",
      ai_release_at: (data && data.ai_release_at) || defaultReleaseIso
    };
    cloudState.submissionsByLessonId[unit.id] = savedRow;

    // Trigger Edge Function in background to correct errors & schedule 12h return
    if (CLOUD && typeof CLOUD.invokeGradeWriting === "function") {
      CLOUD.invokeGradeWriting(rowId)
        .then(gradeRes => {
          if (gradeRes && gradeRes.ok && gradeRes.release_at) {
            const cur = cloudState.submissionsByLessonId[unit.id];
            if (cur) {
              cur.ai_status = gradeRes.status || "scheduled";
              cur.ai_release_at = gradeRes.release_at;
              renderApp();
            }
          }
        })
        .catch(() => {});
    }

    return { ok: true, row: savedRow };
  }

  function getWritingSectionExercises(secObj, activePartKey) {
    if (!secObj || !secObj.parts) return [];
    if (secObj.allExercisesInOneList) {
      return Object.keys(secObj.parts).reduce((acc, pk) => {
        const part = secObj.parts[pk];
        return acc.concat((part && part.exercises) || []);
      }, []);
    }
    const part = secObj.parts[activePartKey] || secObj.parts[Object.keys(secObj.parts)[0]];
    return (part && part.exercises) || [];
  }

  function getWritingWordLimits(ex) {
    const fallbackMin = ex && typeof ex.minWords === "number" ? ex.minWords : 40;
    const fallbackMax = ex && typeof ex.maxWords === "number" ? ex.maxWords : 60;
    const sources = [ex && ex.instruction, ex && ex.promptBox].filter(Boolean);
    for (let i = 0; i < sources.length; i++) {
      const text = String(sources[i]);
      const rangeMatch = text.match(/(\d+)\s*(?:[-–—]|to|đến)\s*(\d+)\s*(?:words?|từ)(?=$|[\s.,;:!?()\]])/i);
      if (rangeMatch) {
        const minW = parseInt(rangeMatch[1], 10);
        const maxW = parseInt(rangeMatch[2], 10);
        if (minW > 0 && maxW >= minW) return { minW, maxW };
      }
      const minMatch = text.match(/(?:at\s+least|minimum(?:\s+of)?|ít\s+nhất)\s*(\d+)\s*(?:words?|từ)(?=$|[\s.,;:!?()\]])/i);
      if (minMatch) {
        const minW = parseInt(minMatch[1], 10);
        if (minW > 0) return { minW, maxW: Math.max(fallbackMax, minW) };
      }
    }
    return { minW: fallbackMin, maxW: fallbackMax };
  }

  function getWritingUnitCounts(unit) {
    const countWords = secKey =>
      Object.values((unit.sections[secKey] && unit.sections[secKey].parts) || {}).reduce(
        (sum, p) => sum + (Array.isArray(p.words) ? p.words.length : 0),
        0
      );
    const countEx = secKey =>
      Object.values((unit.sections[secKey] && unit.sections[secKey].parts) || {}).reduce(
        (sum, p) => sum + (Array.isArray(p.exercises) ? p.exercises.length : 0),
        0
      );
    return {
      vocabWords: countWords("vocabulary"),
      phraseWords: countWords("phrases"),
      vocabEx: countEx("vocabulary"),
      phraseEx: countEx("phrases"),
      writingEx: countEx("writing")
    };
  }

  function getMasterKeywordList() {
    const list = [];
    const seen = new Set();
    const pushItem = (item, group, source) => {
      const key = `${item.q.toLowerCase()}__${item.p.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ ...item, group, source });
    };
    (THEORY.introKeywordExamples || []).forEach(it => pushItem(it, "intro", "Phần 1 · Lý thuyết"));
    Object.keys(PART_META).forEach(partId => {
      const meta = PART_META[partId];
      const guide = GUIDES[partId];
      if (guide && Array.isArray(guide.masterKeywords)) {
        guide.masterKeywords.forEach(it => pushItem(it, partId, `${meta.shortLabel} · Trọng tâm`));
      }
    });
    EXERCISES.forEach(ex => {
      const meta = getPartMeta(ex.part);
      (ex.keywordTable || []).forEach(it =>
        pushItem(it, ex.part, `${meta.code} · Bài ${ex.number}`)
      );
    });
    return list;
  }

  const MASTER_KEYWORDS = getMasterKeywordList();

  function evaluateQuestion(ex, q, rawUserAns) {
    const cleaned = normalizeAnswer(rawUserAns);
    if (!cleaned) return { isCorrect: false, isEmpty: true, trapWarning: "" };

    if (ex.letterMode) {
      const upper = String(rawUserAns || "").trim().toUpperCase();
      if (q.accepted.includes(upper)) {
        return { isCorrect: true, isEmpty: false, trapWarning: "" };
      }
      if (q.wordAnswer && cleaned === normalizeAnswer(q.wordAnswer)) {
        return {
          isCorrect: false,
          isEmpty: false,
          trapWarning: `⚠️ Em hiểu đúng từ "${q.wordAnswer}" nhưng ĐỀ YÊU CẦU GHI CHỮ CÁI (${q.accepted[0]}), không chép từ tiếng Anh!`
        };
      }
      return { isCorrect: false, isEmpty: false, trapWarning: "" };
    }

    if (ex.formatType === "matching" || ex.formatType === "matching-info") {
      const upper = String(rawUserAns || "").trim().toUpperCase();
      return { isCorrect: q.accepted.includes(upper), isEmpty: false, trapWarning: "" };
    }

    if (ex.formatType === "mcq") {
      const selected = String(rawUserAns || "")
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(Boolean)
        .sort();
      if (q.selectCount && q.selectCount > 1) {
        const expected = [...q.accepted].map(s => s.toUpperCase()).sort();
        const isExact =
          selected.length === expected.length &&
          selected.every((v, idx) => v === expected[idx]);
        const warn =
          selected.length !== q.selectCount
            ? `⚠️ Câu này yêu cầu chọn đúng ${q.selectCount} đáp án (em đang chọn ${selected.length}).`
            : "";
        return { isCorrect: isExact, isEmpty: selected.length === 0, trapWarning: warn };
      }
      return { isCorrect: selected.length === 1 && q.accepted.includes(selected[0]), isEmpty: selected.length === 0, trapWarning: "" };
    }

    // Gap-filling text answers
    const wc = countWords(rawUserAns);
    if (ex.maxWords && wc > ex.maxWords) {
      return {
        isCorrect: false,
        isEmpty: false,
        trapWarning: `⚠️ Lỗi vượt giới hạn số từ! Đề chỉ cho phép ${ex.wordLimitLabel}, nhưng em đã điền ${wc} từ.`
      };
    }

    const matched = q.accepted.some(acc => normalizeAnswer(acc) === cleaned);
    return { isCorrect: matched, isEmpty: false, trapWarning: "" };
  }

  function gradeCurrentExercise() {
    const ex = getCurrentExercise();
    const exState = ensureExerciseState(ex.id);
    let score = 0;
    ex.questions.forEach(q => {
      const res = evaluateQuestion(ex, q, exState.answers[q.id] || "");
      if (res.isCorrect) score++;
    });

    exState.submitted = true;
    exState.score = score;
    exState.total = ex.questions.length;
    exState.submittedAt = new Date().toISOString();

    const stu = getActiveStudent();
    const pct = Math.round((score / ex.questions.length) * 100);
    stu.notifications.unshift({
      id: "sub_" + Date.now(),
      title: `Đã chấm: ${ex.title}`,
      sub: `Kết quả ${score}/${ex.questions.length} (${pct}%) — Bấm để xem giải thích bẫy & bằng chứng trong bài.`,
      time: formatDateTime(exState.submittedAt),
      read: false,
      actionExerciseId: ex.id
    });
    if (stu.notifications.length > 20) stu.notifications = stu.notifications.slice(0, 20);

    persist();
    renderApp();
  }

  // --------------------------------------------------------------------------
  // HIGHLIGHTING (FREEFORM SELECTION + WHOLE SENTENCE + SCAN HELPER)
  // --------------------------------------------------------------------------
  function normalizeHighlightColor(val) {
    if (val === true) return "yellow";
    if (typeof val === "string" && HIGHLIGHT_COLORS.some(c => c.key === val)) return val;
    return "";
  }

  function applyTextHighlight(exState, sentId, start, end, color) {
    if (end <= start) return;
    if (!exState.textHighlights) exState.textHighlights = {};
    const prev = Array.isArray(exState.textHighlights[sentId]) ? exState.textHighlights[sentId] : [];
    const next = [];
    prev.forEach(r => {
      if (r.end <= start || r.start >= end) {
        next.push(r);
      } else {
        if (r.start < start) next.push({ start: r.start, end: start, color: r.color });
        if (r.end > end) next.push({ start: end, end: r.end, color: r.color });
      }
    });
    next.push({ start, end, color });
    next.sort((a, b) => a.start - b.start);
    const merged = [];
    next.forEach(r => {
      const last = merged[merged.length - 1];
      if (last && last.color === r.color && last.end >= r.start) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ ...r });
      }
    });
    exState.textHighlights[sentId] = merged;
  }

  function removeOrRecolorTextHighlight(exState, sentId, start, end, activeColor) {
    if (!exState.textHighlights || !Array.isArray(exState.textHighlights[sentId])) return;
    const prev = exState.textHighlights[sentId];
    const target = prev.find(r => r.start <= start && r.end >= end);
    if (!target) return;
    if (target.color === activeColor) {
      const next = [];
      prev.forEach(r => {
        if (r.end <= start || r.start >= end) {
          next.push(r);
        } else {
          if (r.start < start) next.push({ start: r.start, end: start, color: r.color });
          if (r.end > end) next.push({ start: end, end: r.end, color: r.color });
        }
      });
      if (next.length === 0) delete exState.textHighlights[sentId];
      else exState.textHighlights[sentId] = next;
    } else {
      applyTextHighlight(exState, sentId, start, end, activeColor);
    }
  }

  function hasAnyPassageHighlights(exState) {
    const hasSent = Object.values(exState.highlightedSentences || {}).some(v => Boolean(v));
    const hasText = Object.values(exState.textHighlights || {}).some(arr => Array.isArray(arr) && arr.length > 0);
    return hasSent || hasText;
  }

  function decorateSentenceText(rawText, ex, sentId, exState) {
    const text = String(rawText || "");
    const len = text.length;
    if (len === 0) return "";

    const hlArr = new Array(len).fill("");
    const scanArr = new Array(len).fill("");

    const ranges = exState && exState.textHighlights && Array.isArray(exState.textHighlights[sentId])
      ? exState.textHighlights[sentId]
      : [];
    ranges.forEach(r => {
      const c = normalizeHighlightColor(r.color);
      if (!c) return;
      const s = Math.max(0, Math.min(len, r.start));
      const e = Math.max(0, Math.min(len, r.end));
      for (let i = s; i < e; i++) hlArr[i] = c;
    });

    if (state.scanHelperActive && ex && Array.isArray(ex.scanTerms)) {
      const sorted = [...ex.scanTerms].sort((a, b) => b.length - a.length);
      sorted.forEach(term => {
        const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const isNum = /^\d/.test(term);
        const cls = isNum ? "scan-mark-num" : "scan-mark-name";
        const re = new RegExp(`\\b(${safeTerm})\\b`, "g");
        let m;
        while ((m = re.exec(text)) !== null) {
          const s = m.index;
          const e = s + m[0].length;
          let occupied = false;
          for (let i = s; i < e; i++) {
            if (scanArr[i]) { occupied = true; break; }
          }
          if (!occupied) {
            for (let i = s; i < e; i++) scanArr[i] = cls;
          }
        }
      });
    }

    let html = "";
    let i = 0;
    while (i < len) {
      const hl = hlArr[i];
      const sc = scanArr[i];
      let j = i + 1;
      while (j < len && hlArr[j] === hl && scanArr[j] === sc) j++;
      let chunk = escapeHtml(text.slice(i, j));
      if (sc) chunk = `<span class="${sc}">${chunk}</span>`;
      if (hl) {
        chunk = `<mark class="user-hl-mark hl-${hl}" data-hl-sent="${escapeHtml(sentId)}" data-hl-start="${i}" data-hl-end="${j}" data-hl-color="${hl}">${chunk}</mark>`;
      }
      html += chunk;
      i = j;
    }
    return html;
  }

  // --------------------------------------------------------------------------
  // RENDER: SIDEBAR & TOPBAR
  // --------------------------------------------------------------------------
  function domSafeId(s) {
    return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function syncSidebarSkillAccordion(viewName) {
    if (viewName === "reading-hub" || viewName === "part-topics" || viewName === "practice") {
      state.sbReadingCollapsed = false;
      state.sbWritingCollapsed = true;
    } else if (viewName === "writing-hub" || viewName === "writing-lesson") {
      state.sbWritingCollapsed = false;
      state.sbReadingCollapsed = true;
    } else if (viewName === "home") {
      state.sbReadingCollapsed = true;
      state.sbWritingCollapsed = true;
    }
  }

  function renderSidebarHtml() {
    const stu = getActiveStudent();
    const readingDone = getCompletedExercisesCount();
    const readingTotal = EXERCISES.length;
    const writingDone = getCompletedWritingUnitsCount();
    const writingTotal = WRITING_UNITS.length;
    const essaysCount = getSubmittedWritingEssaysList().length;

    const readingParts = [
      { id: "gap-filling", code: "D1", label: "Gap-filling", list: getExercisesByPart("gap-filling") },
      { id: "matching-names", code: "D2", label: "Matching Names", list: getExercisesByPart("matching-names") },
      { id: "multiple-choice", code: "D3", label: "Multiple Choice", list: getExercisesByPart("multiple-choice") },
      { id: "matching-info", code: "D4", label: "Matching Info", list: getExercisesByPart("matching-info") }
    ];

    const isReadingActive =
      state.view === "reading-hub" || state.view === "part-topics" || state.view === "practice";
    const isWritingActive = state.view === "writing-hub" || state.view === "writing-lesson";

    return `
      <div class="ej-sidebar-backdrop" id="ej-sidebar-backdrop"></div>

      <aside class="ej-sidebar" id="ej-sidebar" aria-label="Điều hướng khóa học">
        <div class="ej-sidebar-header">
          <button type="button" class="ej-sb-logo-btn" data-sb-nav="home" title="Về trang chủ">
            <span class="ej-sb-logo-badge">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
            </span>
            <div class="ej-sb-logo-text">
              <span class="ej-sb-logo-main">Reading &amp; Writing</span>
              <span class="ej-sb-logo-sub">Luyện Kỹ Năng IELTS</span>
            </div>
          </button>
        </div>

        <nav class="ej-sidebar-nav">
          <div class="ej-sb-group">
            <button
              type="button"
              class="ej-sb-item ${state.view === "home" ? "active" : ""}"
              data-sb-nav="home"
            >
              <span class="ej-sb-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              </span>
              <span class="ej-sb-label">Trang chủ (2 kỹ năng)</span>
            </button>

            <button
              type="button"
              class="ej-sb-item ${state.view === "keyword-hub" ? "active" : ""}"
              data-sb-nav="keyword-hub"
            >
              <span class="ej-sb-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
              </span>
              <span class="ej-sb-label">Bảng Keyword Table</span>
              <span class="ej-sb-count">${MASTER_KEYWORDS.length}</span>
            </button>

            <button
              type="button"
              class="ej-sb-item ${state.view === "my-submissions" ? "active" : ""}"
              data-sb-nav="my-submissions"
            >
              <span class="ej-sb-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
              </span>
              <span class="ej-sb-label">Lịch sử bài làm</span>
              ${readingDone + essaysCount > 0 ? `<span class="ej-sb-count">${readingDone + essaysCount}</span>` : ""}
            </button>
          </div>

          <!-- SKILL 1: READING -->
          <div class="vs-sb-card ${state.sbReadingCollapsed ? "collapsed" : ""}">
            <div class="vs-sb-card-head">
              <button
                type="button"
                class="ej-sb-item vs-sb-head-btn ${isReadingActive ? "active" : ""}"
                data-sb-nav="reading-hub"
                title="Kỹ năng Reading (4 dạng bài)"
              >
                <span class="vs-sb-task-pill">R</span>
                <span class="ej-sb-label">Reading (${readingDone}/${readingTotal})</span>
              </button>
              <button
                type="button"
                class="vs-sb-acc-toggle"
                id="btn-sb-reading-acc"
                aria-expanded="${state.sbReadingCollapsed ? "false" : "true"}"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>

            <div class="vs-sb-card-list">
              ${readingParts
                .map(part => {
                  const done = part.list.filter(e => stu.exercises[e.id] && stu.exercises[e.id].submitted).length;
                  const isAct =
                    (state.view === "part-topics" && state.selectedPart === part.id) ||
                    (state.view === "practice" && getCurrentExercise().part === part.id);
                  return `
                    <button
                      type="button"
                      class="vs-sb-lesson-btn ${done === part.list.length && part.list.length > 0 ? "submitted" : ""} ${isAct ? "active" : ""}"
                      data-open-part="${part.id}"
                      title="${escapeHtml(part.code + ": " + part.label)}"
                    >
                      <span class="vs-sb-num">${escapeHtml(part.code)}</span>
                      <span class="vs-sb-topic-text">${escapeHtml(part.label)}</span>
                      <span class="vs-sb-mini-prog">${done}/${part.list.length}${done === part.list.length && part.list.length > 0 ? " ✓" : ""}</span>
                    </button>
                  `;
                })
                .join("")}
            </div>
          </div>

          <!-- SKILL 2: WRITING -->
          <div class="vs-sb-card ${state.sbWritingCollapsed ? "collapsed" : ""}">
            <div class="vs-sb-card-head">
              <button
                type="button"
                class="ej-sb-item vs-sb-head-btn ${isWritingActive ? "active" : ""}"
                data-sb-nav="writing-hub"
                title="Kỹ năng Writing (10 bài học)"
              >
                <span class="vs-sb-task-pill wr-pill">W</span>
                <span class="ej-sb-label">Writing (${writingDone}/${writingTotal})</span>
              </button>
              <button
                type="button"
                class="vs-sb-acc-toggle"
                id="btn-sb-writing-acc"
                aria-expanded="${state.sbWritingCollapsed ? "false" : "true"}"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            </div>

            <div class="vs-sb-card-list">
              ${WRITING_UNITS.map(u => {
                const secDone = getWritingUnitDoneSectionsCount(u.id);
                const isDone = secDone >= 3;
                const isAct = state.view === "writing-lesson" && state.currentWritingUnitId === u.id;
                return `
                  <button
                    type="button"
                    class="vs-sb-lesson-btn ${isDone ? "submitted" : ""} ${isAct ? "active" : ""}"
                    data-open-writing-unit="${escapeHtml(u.id)}"
                    title="Unit ${escapeHtml(u.number)}: ${escapeHtml(u.titleEn)}"
                  >
                    <span class="vs-sb-num">${escapeHtml(u.number)}</span>
                    <span class="vs-sb-topic-text">${escapeHtml(u.titleEn)}</span>
                    ${secDone > 0 ? `<span class="vs-sb-mini-prog">${secDone}/3${isDone ? " ✓" : ""}</span>` : ""}
                  </button>
                `;
              }).join("")}
            </div>
          </div>
        </nav>

        <div class="vs-sb-footer">
          <button type="button" class="vs-sb-collapse-footer-btn" id="ej-sidebar-collapse-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>
            <span class="ej-sb-label">Thu gọn menu</span>
          </button>
        </div>
      </aside>
    `;
  }

  function renderTopbarHtml() {
    const stu = getActiveStudent();
    const isPractice = state.view === "practice";
    const isWritingLesson = state.view === "writing-lesson";
    const ex = getCurrentExercise();
    const wrUnit = isWritingLesson ? getCurrentWritingUnit() : null;
    const wrProg = wrUnit ? ensureWritingUnitProgress(wrUnit.id) : null;
    const releasedReviews = getAllReleasedWritingReviews();
    const unreadCloudReviews = releasedReviews.filter(r => !r.student_seen_at).length;
    const unreadLocalNotifs = (stu.notifications || []).filter(n => !n.read).length;
    const unreadNotifs = unreadLocalNotifs + unreadCloudReviews;

    let leftGroupHtml = `
      <button type="button" class="ej-mobile-menu-btn" id="ej-mobile-menu-btn" aria-label="Mở menu">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
    `;

    if (isPractice) {
      leftGroupHtml = `
        <div class="ej-focus-nav-group">
          <button type="button" class="nb-back-btn" id="btn-back-dashboard">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            <span>Danh sách ${escapeHtml(getPartMeta(ex.part).shortLabel)}</span>
          </button>
          <h1 class="header-topic-name">${escapeHtml(ex.title)}</h1>
          <span class="header-part-badge">${escapeHtml(ex.wordLimitLabel)}</span>
        </div>
      `;
    } else if (isWritingLesson && wrUnit) {
      leftGroupHtml = `
        <div class="ej-focus-nav-group wr-topbar-focus">
          <button type="button" class="nb-back-btn" id="btn-back-writing-hub">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            <span>Writing</span>
          </button>
          <div class="wr-topbar-title-wrap">
            <span class="wr-topbar-unit-tag">Unit ${escapeHtml(wrUnit.number)}</span>
            <h1 class="header-topic-name">${escapeHtml(wrUnit.titleEn)}</h1>
          </div>
          <nav class="wr-section-tabs" aria-label="Các phần bài học Writing">
            ${WRITING_SECTIONS.map(sec => {
              const isAct = state.currentWritingSection === sec.key;
              const isDone = wrProg && wrProg.completedSections.includes(sec.key);
              return `
                <button
                  type="button"
                  class="wr-sec-tab ${isAct ? "active" : ""} ${isDone ? "done" : ""}"
                  data-wr-section="${sec.key}"
                >
                  <span class="wr-sec-num">${isDone ? "✓" : sec.num}</span>
                  <span>${escapeHtml(sec.label)}</span>
                </button>
              `;
            }).join("")}
          </nav>
        </div>
      `;
    }

    return `
      <header class="dt-topbar">
        <div class="dt-topbar-inner">
          <div class="dt-topbar-left-group">
            ${leftGroupHtml}
          </div>

          <div class="dt-topbar-right-group">
            ${
              cloudState.isTeacher
                ? `<a href="./teacher.html" class="top-pill-btn teacher-nav-pill" title="Mở trang Giáo viên sửa & trả bài viết">👨‍🏫 Trang Giáo viên</a>`
                : ""
            }
            <div class="notif-menu-wrap" id="topbar-notif-wrap">
              <button
                type="button"
                class="notif-bell-btn ${unreadNotifs > 0 ? "has-unread" : ""}"
                id="topbar-notif-btn"
                title="Thông báo học tập & bài sửa Writing"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                ${unreadNotifs > 0 ? `<span class="notif-unread-badge">${unreadNotifs}</span>` : ""}
              </button>

              ${
                state.notifOpen
                  ? `
                <div class="notif-dropdown">
                  <div class="notif-dropdown-header">
                    <span>Thông báo bài sửa &amp; kết quả</span>
                    <span class="notif-header-sub">Trả bài sau 12 tiếng</span>
                  </div>
                  <div class="notif-dropdown-list">
                    ${
                      releasedReviews.length === 0 && stu.notifications.length === 0
                        ? `<div class="notif-empty-state">Chưa có thông báo nào. Khi bài sửa Writing sẵn sàng (sau 12 tiếng kể từ lúc nộp), thông báo sẽ xuất hiện tại đây.</div>`
                        : `
                          ${releasedReviews
                            .map(rev => {
                              const isUnread = !rev.student_seen_at;
                              const errCount =
                                rev.review_json && Array.isArray(rev.review_json.corrections)
                                  ? rev.review_json.corrections.length
                                  : 0;
                              const relTime = CLOUD ? CLOUD.formatDateTime(rev.release_at) : formatDateTime(rev.release_at);
                              const uObj = WRITING_UNITS.find(u => u.id === rev.lesson_id);
                              const title = uObj ? `Unit ${uObj.number}: ${uObj.titleEn}` : rev.lesson_title || rev.lesson_id;
                              return `
                                <button
                                  type="button"
                                  class="notif-item-btn ${isUnread ? "unread" : ""}"
                                  data-open-writing-unit="${escapeHtml(rev.lesson_id)}"
                                  data-open-writing-sec="writing"
                                  data-mark-review-seen="${escapeHtml(rev.lesson_id)}"
                                >
                                  <div class="notif-item-top">
                                    <span class="notif-item-tag ${isUnread ? "new-dot" : ""}">${isUnread ? "Bài sửa mới" : "✓ Đã xem"}</span>
                                    <span class="notif-item-time">${escapeHtml(relTime)}</span>
                                  </div>
                                  <div class="notif-item-title">✅ Đã trả bài sửa: ${escapeHtml(title)}</div>
                                  <div class="notif-item-sub">${errCount > 0 ? `Phát hiện ${errCount} lỗi cần chú ý — Bấm để xem bài sửa chi tiết.` : "Bài viết rất sạch lỗi — Bấm để xem nhận xét chi tiết."}</div>
                                </button>
                              `;
                            })
                            .join("")}
                          ${stu.notifications
                            .map(
                              n => `
                              <button
                                type="button"
                                class="notif-item-btn ${!n.read ? "unread" : ""}"
                                data-notif-id="${escapeHtml(n.id)}"
                                ${n.actionExerciseId ? `data-open-exercise="${escapeHtml(n.actionExerciseId)}"` : ""}
                                ${n.actionWritingUnitId ? `data-open-writing-unit="${escapeHtml(n.actionWritingUnitId)}" data-open-writing-sec="${escapeHtml(n.actionWritingSec || "writing")}"` : ""}
                                ${n.actionView ? `data-sb-nav="${escapeHtml(n.actionView)}"` : ""}
                              >
                                <div class="notif-item-top">
                                  <span class="notif-item-tag ${!n.read ? "new-dot" : ""}">${!n.read ? "Mới" : "✓ Đã xem"}</span>
                                  <span class="notif-item-time">${escapeHtml(n.time || "")}</span>
                                </div>
                                <div class="notif-item-title">${escapeHtml(n.title)}</div>
                                <div class="notif-item-sub">${escapeHtml(n.sub)}</div>
                              </button>
                            `
                            )
                            .join("")}
                        `
                    }
                  </div>
                </div>
              `
                  : ""
              }
            </div>

            <div class="account-menu-wrap" id="topbar-account-menu-wrap">
              <button type="button" class="user-account-pill" id="btn-toggle-account-menu">
                <span class="user-initials">${escapeHtml(getInitials(stu.name))}</span>
                <span>${escapeHtml(stu.name)}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
              </button>

              ${
                state.accountMenuOpen
                  ? `
                <div class="account-dropdown">
                  <div class="account-dropdown-meta">
                    <div class="account-dropdown-role">${escapeHtml((currentAccount && currentAccount.name) || stu.name)}</div>
                    ${currentAccount && currentAccount.email ? `<div class="account-dropdown-email">${escapeHtml(currentAccount.email)}</div>` : ""}
                  </div>
                  <button type="button" class="account-menu-item" id="btn-open-vocab-bank">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
                    <span>Kho từ vựng của tôi</span>
                    <span class="account-menu-count">${stu.savedVocab.length}</span>
                  </button>
                  <button type="button" class="account-logout-item" id="btn-logout-account">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                    <span>Đăng xuất</span>
                  </button>
                </div>
              `
                  : ""
              }
            </div>
          </div>
        </div>
      </header>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 1: DUAL-SKILL HOME HUB (READING & WRITING)
  // --------------------------------------------------------------------------
  function renderHomeView() {
    const readingDone = getCompletedExercisesCount();
    const readingTotal = EXERCISES.length;
    const writingDone = getCompletedWritingUnitsCount();
    const writingTotal = WRITING_UNITS.length;

    const gapList = getExercisesByPart("gap-filling");
    const matchList = getExercisesByPart("matching-names");
    const mcqList = getExercisesByPart("multiple-choice");
    const infoList = getExercisesByPart("matching-info");

    return `
      <main class="home-container">
        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">LUYỆN KỸ NĂNG TIẾNG ANH · READING &amp; WRITING</div>
            <h1 class="home-h1">CHỌN KỸ NĂNG LUYỆN TẬP</h1>
          </div>
        </div>

        <div class="parts-hub-grid skill-home-grid">
          <!-- SKILL CARD 1: READING -->
          <article class="topic-card skill-hub-card" data-sb-nav="reading-hub">
            <div class="topic-card-top">
              <div class="topic-num-badge skill-badge-reading">READING</div>
              <span class="topic-progress-tag ${readingDone === readingTotal && readingTotal > 0 ? "done" : ""}">
                ${readingDone === readingTotal && readingTotal > 0 ? `Hoàn thành ${readingTotal}/${readingTotal} ✓` : `Đã làm ${readingDone}/${readingTotal} bài`}
              </span>
            </div>

            <h2 class="topic-card-title">Luyện Kỹ Năng Reading</h2>
            <div class="topic-card-vi">4 Dạng câu hỏi trọng tâm · ${readingTotal} Bài đọc thực hành</div>
            <p class="topic-card-desc">
              Luyện đọc hiểu với bút gạch chân 5 màu, quét tên riêng &amp; số liệu, dịch từng câu, bảng Keyword Table và chấm điểm giải thích chi tiết từng câu.
            </p>

            <ul class="topic-questions-preview">
              <li><span class="preview-q-num">D1.</span><span><strong>Gap-filling</strong> — Điền từ vào chỗ trống (${gapList.length} bài)</span></li>
              <li><span class="preview-q-num">D2.</span><span><strong>Matching Names</strong> — Nối tên riêng với phát biểu (${matchList.length} bài)</span></li>
              <li><span class="preview-q-num">D3.</span><span><strong>Multiple Choice</strong> — Trắc nghiệm nhiều lựa chọn (${mcqList.length} bài)</span></li>
              <li><span class="preview-q-num">D4.</span><span><strong>Matching Information</strong> — Tìm đoạn chứa thông tin (${infoList.length} bài)</span></li>
            </ul>

            <div class="topic-card-footer">
              <span>4 Chuyên đề · ${readingTotal} bài thực hành</span>
              <span>Vào luyện Reading →</span>
            </div>
          </article>

          <!-- SKILL CARD 2: WRITING -->
          <article class="topic-card skill-hub-card" data-sb-nav="writing-hub">
            <div class="topic-card-top">
              <div class="topic-num-badge skill-badge-writing">WRITING</div>
              <span class="topic-progress-tag ${writingDone === writingTotal && writingTotal > 0 ? "done" : ""}">
                ${writingDone === writingTotal && writingTotal > 0 ? `Hoàn thành ${writingTotal}/${writingTotal} ✓` : `Hoàn thành ${writingDone}/${writingTotal} bài học`}
              </span>
            </div>

            <h2 class="topic-card-title">Luyện Kỹ Năng Writing</h2>
            <div class="topic-card-vi">${writingTotal} Chủ đề · Vocabulary · Phrases · Writing</div>
            <p class="topic-card-desc">
              Xây dựng kỹ năng viết chắc chắn qua 3 bước trong mỗi bài: học Từ vựng trọng tâm (Vocabulary), Cụm từ diễn đạt (Phrases) và thực hành Viết bài hoàn chỉnh (Writing) kèm dàn ý &amp; bài mẫu.
            </p>

            <ul class="topic-questions-preview">
              <li><span class="preview-q-num">01–03.</span><span>Greetings &amp; Introductions · Countries &amp; Languages · Numbers, Dates &amp; Time</span></li>
              <li><span class="preview-q-num">04–06.</span><span>Family &amp; Friends · Physical Appearance · Feelings &amp; Emotions</span></li>
              <li><span class="preview-q-num">07–08.</span><span>Jobs &amp; Occupations · Daily Routines</span></li>
              <li><span class="preview-q-num">09–10.</span><span>House &amp; Rooms · Furniture &amp; Household Items</span></li>
            </ul>

            <div class="topic-card-footer">
              <span>${writingTotal} Bài học · 3 phần mỗi bài</span>
              <span>Vào luyện Writing →</span>
            </div>
          </article>
        </div>
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 1B: READING HUB (4 READING QUESTION TYPES)
  // --------------------------------------------------------------------------
  function renderReadingHubView() {
    const stu = getActiveStudent();
    const gapList = getExercisesByPart("gap-filling");
    const matchList = getExercisesByPart("matching-names");
    const mcqList = getExercisesByPart("multiple-choice");
    const infoList = getExercisesByPart("matching-info");

    const countDone = list => list.filter(e => stu.exercises[e.id] && stu.exercises[e.id].submitted).length;
    const countQs = list => list.reduce((sum, e) => sum + (e.questions ? e.questions.length : 0), 0);

    const gapDone = countDone(gapList);
    const matchDone = countDone(matchList);
    const mcqDone = countDone(mcqList);
    const infoDone = countDone(infoList);

    return `
      <main class="home-container">
        <div style="margin-bottom:14px;">
          <button type="button" class="nb-back-btn" data-sb-nav="home">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            <span>Quay lại Trang chủ</span>
          </button>
        </div>

        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">KỸ NĂNG ĐỌC HIỂU · 4 DẠNG BÀI TRỌNG TÂM</div>
            <h1 class="home-h1">TÀI LIỆU IELTS READING TINH GỌN</h1>
          </div>
        </div>

        <div class="parts-hub-grid">
          <article class="topic-card" data-open-part="gap-filling">
            <div class="topic-card-top">
              <div class="topic-num-badge">D1</div>
              <span class="topic-progress-tag ${gapDone === gapList.length ? "done" : ""}">
                ${gapDone === gapList.length ? `Hoàn thành ${gapList.length}/${gapList.length} ✓` : `Đã làm ${gapDone}/${gapList.length} bài`}
              </span>
            </div>

            <h2 class="topic-card-title">Dạng 1: Gap-filling</h2>
            <div class="topic-card-vi">Điền từ vào chỗ trống · Đáp án THEO THỨ TỰ ✅</div>
            <p class="topic-card-desc">
              Dạng bài phổ biến và dễ lấy điểm trong hầu hết các đề thi IELTS. Bao gồm đủ 4 biến thể thực tế: Note Completion, Table Completion, Summary Completion và Hộp từ A–H.
            </p>

            <ul class="topic-questions-preview">
              <li><span class="preview-q-num">01.</span><span>Cork – The Cork Oak (ONE WORD ONLY)</span></li>
              <li><span class="preview-q-num">02.</span><span>The Coconut Palm (ONE WORD AND/OR A NUMBER)</span></li>
              <li><span class="preview-q-num">03.</span><span>Indoor Vertical Farming (NO MORE THAN TWO WORDS)</span></li>
              <li><span class="preview-q-num">04.</span><span>Human Laughter (Summary Word Box A–H)</span></li>
            </ul>

            <div class="topic-card-footer">
              <span>${gapList.length} Bài thực hành · ${countQs(gapList)} câu hỏi</span>
              <span>Vào luyện đề →</span>
            </div>
          </article>

          <article class="topic-card" data-open-part="matching-names">
            <div class="topic-card-top">
              <div class="topic-num-badge">D2</div>
              <span class="topic-progress-tag ${matchDone === matchList.length ? "done" : ""}">
                ${matchDone === matchList.length ? `Hoàn thành ${matchList.length}/${matchList.length} ✓` : `Đã làm ${matchDone}/${matchList.length} bài`}
              </span>
            </div>

            <h2 class="topic-card-title">Dạng 2: Matching Names</h2>
            <div class="topic-card-vi">Nối tên riêng với phát biểu · Ưu tiên tên xuất hiện 1 lần</div>
            <p class="topic-card-desc">
              Dạng bài dễ định vị nhất vì Tên riêng luôn viết hoa! Thực hành mẹo làm từ "tên xuất hiện 1 lần", chú ý Họ (Surname), dòng NB dùng lặp và bẫy Đồng tình / Bác bỏ.
            </p>

            <ul class="topic-questions-preview">
              <li><span class="preview-q-num">01.</span><span>Children's Play (Specialists A–E · có nhiễu)</span></li>
              <li><span class="preview-q-num">02.</span><span>Remote Work (Mẹo Tên 1 lần &amp; Họ 'Bloom')</span></li>
              <li><span class="preview-q-num">03.</span><span>Migrating Birds (Có NB dùng lặp chữ cái)</span></li>
              <li><span class="preview-q-num">04.</span><span>Modern Museums (Bẫy Đồng tình / Bác bỏ)</span></li>
            </ul>

            <div class="topic-card-footer">
              <span>${matchList.length} Bài thực hành · ${countQs(matchList)} câu hỏi</span>
              <span>Vào luyện đề →</span>
            </div>
          </article>

          <article class="topic-card" data-open-part="multiple-choice">
            <div class="topic-card-top">
              <div class="topic-num-badge">D3</div>
              <span class="topic-progress-tag ${mcqDone === mcqList.length && mcqList.length > 0 ? "done" : ""}">
                ${mcqDone === mcqList.length && mcqList.length > 0 ? `Hoàn thành ${mcqList.length}/${mcqList.length} ✓` : `Đã làm ${mcqDone}/${mcqList.length} bài`}
              </span>
            </div>

            <h2 class="topic-card-title">Dạng 3: Multiple Choice</h2>
            <div class="topic-card-vi">Trắc nghiệm nhiều lựa chọn · Loại trừ phương án nhiễu</div>
            <p class="topic-card-desc">
              Tổng hợp bài tập trắc nghiệm nhiều lựa chọn: Chọn 1 đáp án đúng (A–C / A–D), Chọn tiêu đề đúng nhất (Choose the title) và Chọn nhiều đáp án đúng (Choose TWO / THREE).
            </p>

            <ul class="topic-questions-preview">
              <li><span class="preview-q-num">01.</span><span>Ecotourism &amp; The Placebo Effect (Chọn 1 đáp án A–C)</span></li>
              <li><span class="preview-q-num">02.</span><span>Super-Earth HD 40307g, IQ &amp; Learning Styles</span></li>
              <li><span class="preview-q-num">03.</span><span>Mindsets (Chọn TWO) &amp; Thames Tunnel (Chọn THREE)</span></li>
              <li><span class="preview-q-num">04.</span><span>US Schools Behaviour (Chọn tiêu đề đúng nhất)</span></li>
            </ul>

            <div class="topic-card-footer">
              <span>${mcqList.length} Bài thực hành · ${countQs(mcqList)} câu hỏi</span>
              <span>Vào luyện đề →</span>
            </div>
          </article>

          <article class="topic-card" data-open-part="matching-info">
            <div class="topic-card-top">
              <div class="topic-num-badge">D4</div>
              <span class="topic-progress-tag ${infoDone === infoList.length && infoList.length > 0 ? "done" : ""}">
                ${infoDone === infoList.length && infoList.length > 0 ? `Hoàn thành ${infoList.length}/${infoList.length} ✓` : `Đã làm ${infoDone}/${infoList.length} bài`}
              </span>
            </div>

            <h2 class="topic-card-title">Dạng 4: Matching Information</h2>
            <div class="topic-card-vi">Tìm đoạn chứa thông tin (Which paragraph contains...?)</div>
            <p class="topic-card-desc">
              Tìm một chi tiết cụ thể nằm trong đoạn A, B, C... (khác với Matching Headings). Lưu ý thứ tự câu hỏi bị xáo trộn và cùng một đoạn có thể chứa nhiều hơn một đáp án.
            </p>

            <ul class="topic-questions-preview">
              <li><span class="preview-q-num">01.</span><span>The Tutorial Method of Teaching — Oxford (Đoạn A–C)</span></li>
              <li><span class="preview-q-num">02.</span><span>The Changing Role of Public Libraries (Đoạn A–D · có đoạn trống)</span></li>
              <li><span class="preview-q-num">03.</span><span>Urban Rooftop Gardens (Đoạn A–D · số liệu &amp; thành phố)</span></li>
              <li><span class="preview-q-num">04.</span><span>How Sleep Affects Memory and Learning (Đoạn A–D · NB dùng lặp)</span></li>
            </ul>

            <div class="topic-card-footer">
              <span>${infoList.length} Bài thực hành · ${countQs(infoList)} câu hỏi</span>
              <span>Vào luyện đề →</span>
            </div>
          </article>
        </div>
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 1C: WRITING HUB (10 UNITS: VOCABULARY · PHRASES · WRITING)
  // --------------------------------------------------------------------------
  function renderWritingHubView() {
    const stu = getActiveStudent();

    return `
      <main class="home-container">
        <div style="margin-bottom:14px;">
          <button type="button" class="nb-back-btn" data-sb-nav="home">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            <span>Quay lại Trang chủ</span>
          </button>
        </div>

        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">KỸ NĂNG VIẾT · VOCABULARY · PHRASES · WRITING</div>
            <h1 class="home-h1">LUYỆN KỸ NĂNG WRITING (${WRITING_UNITS.length} BÀI HỌC)</h1>
            <p class="home-desc">
              Mỗi bài học gồm 3 phần liền mạch: <strong>1. Vocabulary</strong> (Từ vựng + nghe US/UK), <strong>2. Phrases</strong> (Cụm từ &amp; câu mẫu) và <strong>3. Writing</strong> (Dàn ý gợi ý + thực hành viết đoạn kèm bài mẫu).
            </p>
          </div>
        </div>

        <div class="topics-grid">
          ${WRITING_UNITS.map(unit => {
            const prog = (stu.writingProgress && stu.writingProgress[unit.id]) || { completedSections: [] };
            const doneCount = WRITING_SECTIONS.filter(s => (prog.completedSections || []).includes(s.key)).length;
            const isAllDone = doneCount >= 3;
            const counts = getWritingUnitCounts(unit);

            return `
              <article class="topic-card wr-unit-card" data-open-writing-unit="${escapeHtml(unit.id)}">
                <div class="topic-card-top">
                  <div class="topic-num-badge">${escapeHtml(unit.number)}</div>
                  <span class="topic-progress-tag ${isAllDone ? "done" : doneCount > 0 ? "warn" : ""}">
                    ${isAllDone ? "Hoàn thành 3/3 ✓" : doneCount > 0 ? `Đã học ${doneCount}/3 phần` : "3 phần học"}
                  </span>
                </div>

                <h2 class="topic-card-title">${escapeHtml(unit.titleEn)}</h2>
                <div class="topic-card-vi">${escapeHtml(unit.titleVi)}</div>
                <p class="topic-card-desc">${escapeHtml(unit.description)}</p>

                <div class="wr-unit-sec-pills">
                  ${WRITING_SECTIONS.map(sec => {
                    const secDone = (prog.completedSections || []).includes(sec.key);
                    return `
                      <button
                        type="button"
                        class="wr-unit-sec-chip ${secDone ? "done" : ""}"
                        data-open-writing-unit="${escapeHtml(unit.id)}"
                        data-open-writing-sec="${sec.key}"
                      >
                        <span>${secDone ? "✓" : sec.num + "."}</span>
                        <span>${escapeHtml(sec.label)}</span>
                      </button>
                    `;
                  }).join("")}
                </div>

                <div class="topic-card-footer">
                  <span>${counts.vocabWords} từ · ${counts.phraseWords} cụm · ${counts.writingEx} bài viết</span>
                  <span>${doneCount > 0 ? "Học tiếp →" : "Vào học →"}</span>
                </div>
              </article>
            `;
          }).join("")}
        </div>
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 1D: WRITING LESSON WORKSPACE (50/50 SPLIT: THEORY & EXERCISES)
  // --------------------------------------------------------------------------
  function renderWritingDialoguesHtml(exampleSentences) {
    if (!exampleSentences || exampleSentences.length === 0) return "";
    return `
      <ul class="wr-dialogue-list">
        ${exampleSentences
          .map(
            ex => `
          <li class="wr-dialogue-row">
            <div style="min-width:0;flex:1;">
              <p class="wr-dialogue-en">${escapeHtml(ex.en)}</p>
              <p class="wr-dialogue-vi">${escapeHtml(ex.vi)}</p>
            </div>
            <button
              type="button"
              class="wr-speak-btn"
              data-speak-word="${escapeHtml(ex.en)}"
              data-speak-accent="US"
              title="Nghe câu mẫu"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            </button>
          </li>
        `
          )
          .join("")}
      </ul>
    `;
  }

  function renderWritingWordsHtml(words, unit, secLabel) {
    if (!words || words.length === 0) return "";
    const stu = getActiveStudent();
    const sourceTopic = `Writing Unit ${unit.number} · ${secLabel}`;
    return `
      <ul class="wr-vocab-list">
        ${words
          .map(w => {
            const isSaved = stu.savedVocab.some(v => v.word.toLowerCase() === String(w.word || "").toLowerCase());
            return `
              <li class="wr-vocab-card">
                <div style="min-width:0;flex:1;">
                  <p class="wr-vocab-head-line">
                    <span class="wr-vocab-word">${escapeHtml(w.word)}</span>
                    ${w.ipa ? `<span class="wr-vocab-ipa">${escapeHtml(w.ipa)}</span>` : ""}
                    <span class="wr-vocab-meaning">${escapeHtml(w.meaning)}</span>
                  </p>
                  ${
                    w.exampleEn || w.exampleVi
                      ? `
                    <p class="wr-vocab-example">
                      ${w.exampleEn ? `<span class="wr-vocab-ex-en">${escapeHtml(w.exampleEn)}</span>` : ""}
                      ${w.exampleVi ? `<span class="wr-vocab-ex-vi">${escapeHtml(w.exampleVi)}</span>` : ""}
                    </p>
                  `
                      : ""
                  }
                </div>
                <div class="wr-vocab-actions">
                  <button type="button" class="wr-voice-btn" data-speak-word="${escapeHtml(w.word)}" data-speak-accent="US" title="Giọng Mỹ (US)">🔊 US</button>
                  <button type="button" class="wr-voice-btn" data-speak-word="${escapeHtml(w.word)}" data-speak-accent="UK" title="Giọng Anh (UK)">🔊 UK</button>
                  <button
                    type="button"
                    class="vocab-save-mini-btn ${isSaved ? "saved" : ""}"
                    data-toggle-save-vocab="${escapeHtml(w.word)}"
                    data-vocab-ipa="${escapeHtml(w.ipa || "")}"
                    data-vocab-pos="${secLabel.toLowerCase()}"
                    data-vocab-meaning="${escapeHtml(w.meaning || "")}"
                    data-vocab-example="${escapeHtml(w.exampleEn || "")}"
                    data-vocab-topic="${escapeHtml(sourceTopic)}"
                    title="Lưu vào Kho từ vựng của tôi"
                  >${isSaved ? "✓" : "+ Lưu"}</button>
                </div>
              </li>
            `;
          })
          .join("")}
      </ul>
    `;
  }

  function renderWritingSinglePartTheoryHtml(part, unit, secLabel, isCurrentPart, hasMultipleParts) {
    if (!part) return "";
    return `
      <section
        id="wr-theory-part-${escapeHtml(part.code)}"
        class="wr-theory-part ${hasMultipleParts && isCurrentPart ? "is-active" : ""}"
      >
        <header class="wr-part-header">
          <span class="wr-part-badge">${escapeHtml(part.code)}</span>
          <div style="min-width:0;flex:1;">
            <h2 class="wr-part-title-en">${escapeHtml(part.titleEn)}</h2>
            ${part.titleVi ? `<p class="wr-part-title-vi">${escapeHtml(part.titleVi)}</p>` : ""}
          </div>
          ${
            hasMultipleParts && !isCurrentPart
              ? `<button type="button" class="wr-switch-part-btn" data-wr-part="${escapeHtml(part.code)}">Làm bài Part ${escapeHtml(part.code)} →</button>`
              : ""
          }
        </header>

        ${
          part.intro || (part.bullets && part.bullets.length > 0) || part.writingSteps
            ? `
          <div class="wr-prose-block">
            ${part.intro ? `<p class="wr-intro-text">${escapeHtml(part.intro)}</p>` : ""}
            ${
              part.bullets && part.bullets.length > 0
                ? `<ul class="wr-bullet-list">${part.bullets.map(b => `<li>${b}</li>`).join("")}</ul>`
                : ""
            }
            ${
              part.writingSteps
                ? `
              <div class="wr-steps-box">
                ${part.writingStepsHeader !== "" ? `<p class="wr-steps-head">${escapeHtml(part.writingStepsHeader || "Bài viết nên có các ý sau:")}</p>` : ""}
                <div class="wr-steps-list">
                  ${part.writingSteps.map(step => `<p class="wr-step-item">${step}</p>`).join("")}
                </div>
              </div>
            `
                : ""
            }
          </div>
        `
            : ""
        }

        ${
          part.figureTop
            ? `<figure class="wr-figure"><img src="${escapeHtml(part.figureTop)}" alt="${escapeHtml(part.titleEn)}" class="wr-illustration-img" /></figure>`
            : ""
        }

        ${
          part.table
            ? `
          <div class="wr-table-wrap">
            <table class="wr-theory-table">
              <thead>
                <tr>${part.table.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>
              </thead>
              <tbody>
                ${part.table.rows
                  .map(
                    row => `
                  <tr>${row.map((cell, idx) => `<td class="${idx === 0 ? "cell-primary" : "cell-secondary"}">${escapeHtml(cell)}</td>`).join("")}</tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `
            : ""
        }

        ${
          part.wordsBeforeDialogues
            ? `
          ${renderWritingWordsHtml(part.words, unit, secLabel)}
          ${renderWritingDialoguesHtml(part.exampleSentences)}
        `
            : `
          ${renderWritingDialoguesHtml(part.exampleSentences)}
          ${
            part.figureBeforeWords
              ? `<figure class="wr-figure"><img src="${escapeHtml(part.figureBeforeWords)}" alt="${escapeHtml(part.titleEn)}" class="wr-illustration-img" /></figure>`
              : ""
          }
          ${renderWritingWordsHtml(part.words, unit, secLabel)}
        `
        }

        ${
          part.outlineGuide
            ? `
          <details class="wr-outline-accordion">
            <summary class="wr-outline-summary">
              <span>📋 Gợi ý dàn bài &amp; từ vựng nên dùng</span>
            </summary>
            <div class="wr-outline-body">
              ${
                part.outlineGuide.analysis && part.outlineGuide.analysis.length > 0
                  ? `
                <div>
                  <h3 class="wr-outline-h3">I. Phân tích đề bài</h3>
                  <ul class="wr-bullet-list">${part.outlineGuide.analysis.map(it => `<li>${it}</li>`).join("")}</ul>
                </div>
              `
                  : ""
              }
              ${
                part.outlineGuide.outline && part.outlineGuide.outline.length > 0
                  ? `
                <div>
                  <h3 class="wr-outline-h3">II. Dàn ý chi tiết</h3>
                  <ul class="wr-bullet-list">
                    ${part.outlineGuide.outline
                      .map(
                        it => `
                      <li style="margin-bottom:6px;">
                        <div>${it.text}</div>
                        ${it.quote ? `<blockquote class="wr-outline-quote">${escapeHtml(it.quote)}</blockquote>` : ""}
                      </li>
                    `
                      )
                      .join("")}
                  </ul>
                </div>
              `
                  : ""
              }
              ${
                part.outlineGuide.mistakes && part.outlineGuide.mistakes.length > 0
                  ? `
                <div>
                  <h3 class="wr-outline-h3">III. Lỗi cần tránh</h3>
                  <ul class="wr-bullet-list">${part.outlineGuide.mistakes.map(m => `<li>${escapeHtml(m)}</li>`).join("")}</ul>
                </div>
              `
                  : ""
              }
              ${
                part.outlineGuide.vocab && part.outlineGuide.vocab.length > 0
                  ? `
                <div>
                  <h3 class="wr-outline-h3">IV. Từ vựng nên dùng</h3>
                  <div class="wr-table-wrap">
                    <table class="wr-theory-table">
                      <thead>
                        <tr><th>Từ / cụm từ</th><th>Loại từ</th><th>Nghĩa</th><th>Ví dụ</th></tr>
                      </thead>
                      <tbody>
                        ${part.outlineGuide.vocab
                          .map(
                            row => `
                          <tr>
                            <td class="cell-primary">${escapeHtml(row[0])}</td>
                            <td class="cell-secondary">${escapeHtml(row[1])}</td>
                            <td class="cell-secondary">${escapeHtml(row[2])}</td>
                            <td class="cell-secondary">${escapeHtml(row[3])}</td>
                          </tr>
                        `
                          )
                          .join("")}
                      </tbody>
                    </table>
                  </div>
                </div>
              `
                  : ""
              }
            </div>
          </details>
        `
            : ""
        }

        ${
          part.callout
            ? `
          <div class="wr-callout-box">
            <p class="wr-callout-title">💡 ${escapeHtml(part.callout.title)}</p>
            <div>${escapeHtml(part.callout.text)}</div>
          </div>
        `
            : ""
        }
      </section>
    `;
  }

  function renderWrMatchingExercise(ex, exKey, prog, isChecked) {
    const opts = ex.options || [];
    const maxOptLen = opts.reduce((max, o) => Math.max(max, String(o.text || "").length), 0);
    const poolCls =
      opts.length === 4 && maxOptLen <= 16
        ? "cols-4"
        : opts.length <= 2
          ? "cols-2"
          : maxOptLen > 68
            ? "cols-1"
            : "cols-2";

    return `
      <div class="wr-matching-pool ${poolCls}">
        ${opts
          .map(
            opt => `
          <div class="wr-matching-pool-row">
            <span class="wr-pool-key">${escapeHtml(opt.key)}</span>
            <span class="wr-pool-text">${escapeHtml(opt.text)}</span>
          </div>
        `
          )
          .join("")}
      </div>
      <div class="wr-items-stack">
        ${(ex.items || [])
          .map(item => {
            const ansKey = `${exKey}_${item.num}`;
            const val = prog.exerciseAnswers[ansKey] || "";
            const isCorrect = val === item.answer;
            const statusCls = isChecked ? (isCorrect ? "correct" : "wrong") : val === "" ? "unselected" : "";
            return `
              <div class="wr-item-row">
                <span class="wr-item-idx ${val !== "" ? "filled" : ""}">${item.num}</span>
                <span class="wr-item-text">${escapeHtml(item.prompt)}</span>
                <select class="wr-match-select ${statusCls}" data-wr-select="${escapeHtml(ansKey)}" data-wr-parent="${escapeHtml(exKey)}">
                  <option value="" ${val === "" ? "selected" : ""}>${item.num}</option>
                  ${(ex.options || []).map(o => `<option value="${escapeHtml(o.key)}" ${val === o.key ? "selected" : ""}>${escapeHtml(o.key)}</option>`).join("")}
                </select>
                ${isChecked ? `<span class="wr-inline-fb ${isCorrect ? "ok" : "err"}">${isCorrect ? "✓ Đúng" : `✗ Đáp án: ${escapeHtml(item.answer)}`}</span>` : ""}
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderWrMcqExercise(ex, exKey, prog, isChecked) {
    return (ex.items || [])
      .map(item => {
        const ansKey = `${exKey}_${item.num}`;
        const val = prog.exerciseAnswers[ansKey] || "";
        return `
          <div class="wr-q-block">
            <div class="wr-q-prompt">
              <span class="wr-item-idx ${val ? "filled" : ""}">${item.num}</span>
              <span>${escapeHtml(item.prompt)}</span>
            </div>
            <div class="wr-choices-stack">
              ${(item.choices || [])
                .map(ch => {
                  const selected = val === ch.key;
                  let cls = selected ? "selected" : "";
                  if (isChecked) {
                    if (ch.key === item.answer) cls = "correct";
                    else if (selected && ch.key !== item.answer) cls = "wrong";
                  }
                  return `
                    <button type="button" class="wr-choice-btn ${cls}" data-wr-mcq-key="${escapeHtml(ansKey)}" data-wr-mcq-val="${escapeHtml(ch.key)}" data-wr-parent="${escapeHtml(exKey)}">
                      <span class="wr-choice-badge">${escapeHtml(ch.key)}</span>
                      <span>${escapeHtml(ch.text)}</span>
                    </button>
                  `;
                })
                .join("")}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderWrTfExercise(ex, exKey, prog, isChecked) {
    return (ex.items || [])
      .map(item => {
        const ansKey = `${exKey}_${item.num}`;
        const val = prog.exerciseAnswers[ansKey] || "";
        return `
          <div class="wr-q-block">
            <div class="wr-q-prompt">
              <span class="wr-item-idx ${val ? "filled" : ""}">${item.num}</span>
              <span>${escapeHtml(item.prompt)}</span>
            </div>
            <div class="wr-choices-stack wr-tf-row">
              ${["True", "False"]
                .map(tf => {
                  const selected = val === tf;
                  let cls = selected ? "selected" : "";
                  if (isChecked) {
                    if (tf === item.answer) cls = "correct";
                    else if (selected && tf !== item.answer) cls = "wrong";
                  }
                  return `
                    <button type="button" class="wr-choice-btn ${cls}" data-wr-mcq-key="${escapeHtml(ansKey)}" data-wr-mcq-val="${tf}" data-wr-parent="${escapeHtml(exKey)}">
                      <span class="wr-choice-badge">${tf[0]}</span>
                      <span>${tf}</span>
                    </button>
                  `;
                })
                .join("")}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderWrFillExercise(ex, exKey, prog, isChecked) {
    return `
      <div class="wr-items-stack">
        ${(ex.items || [])
          .map(item => {
            const ansKey = `${exKey}_${item.num}`;
            const val = prog.exerciseAnswers[ansKey] || "";
            const isCorrect = val.trim().toLowerCase() === String(item.answer || "").trim().toLowerCase();
            const statusCls = isChecked ? (isCorrect ? "correct" : "wrong") : "";
            return `
              <div class="wr-item-row wr-fill-row">
                <span class="wr-item-idx ${val.trim() !== "" ? "filled" : ""}" id="wr-badge-${domSafeId(ansKey)}">${item.num}</span>
                <span class="wr-fill-sentence">
                  ${escapeHtml(item.before)}
                  <input
                    type="text"
                    class="wr-fill-input ${statusCls}"
                    placeholder="${item.num}"
                    value="${escapeHtml(val)}"
                    data-wr-fill-key="${escapeHtml(ansKey)}"
                    data-wr-parent="${escapeHtml(exKey)}"
                  />
                  <span class="wr-fill-after">${escapeHtml(item.after)}</span>
                </span>
                ${isChecked ? `<span class="wr-inline-fb ${isCorrect ? "ok" : "err"}">${isCorrect ? "✓ Đúng" : `✗ ${escapeHtml(item.answer)}`}</span>` : ""}
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderWrRewriteExercise(ex, exKey, prog, isChecked) {
    return `
      <div class="wr-items-stack">
        ${(ex.items || [])
          .map(item => {
            const ansKey = `${exKey}_${item.num}`;
            const val = prog.exerciseAnswers[ansKey] || "";
            const isCorrect = normalizeWritingSentence(val) === normalizeWritingSentence(item.answer);
            const statusCls = isChecked ? (isCorrect ? "correct" : "wrong") : "";
            return `
              <div class="wr-item-row" style="align-items:flex-start;">
                <span class="wr-item-idx ${val.trim() !== "" ? "filled" : ""}" id="wr-badge-${domSafeId(ansKey)}" style="margin-top:2px;">${item.num}</span>
                <div style="flex:1;min-width:0;">
                  <div class="wr-rewrite-prompt">${escapeHtml(item.prompt)}</div>
                  <div class="wr-rewrite-controls">
                    <input
                      type="text"
                      class="wr-fill-input wr-rewrite-input ${statusCls}"
                      placeholder="Viết lại câu ${item.num}..."
                      value="${escapeHtml(val)}"
                      data-wr-fill-key="${escapeHtml(ansKey)}"
                      data-wr-parent="${escapeHtml(exKey)}"
                    />
                    ${isChecked ? `<span class="wr-inline-fb ${isCorrect ? "ok" : "err"}">${isCorrect ? "✓ Đúng" : `✗ Đáp án: ${escapeHtml(item.answer)}`}</span>` : ""}
                  </div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderWrReorderExercise(ex, exKey, prog, isChecked) {
    return (ex.items || [])
      .map(item => {
        const ansKey = `${exKey}_${item.num}`;
        const chosenIndices = Array.isArray(prog.exerciseAnswers[ansKey]) ? prog.exerciseAnswers[ansKey] : [];
        const builtSentence = chosenIndices.map(idx => item.tiles[idx]).join(" ");
        const isCorrect = normalizeWritingSentence(builtSentence) === normalizeWritingSentence(item.answer);
        const statusCls = isChecked ? (isCorrect ? "correct" : "wrong") : "";
        const isActiveRow = state.activeReorderKey === ansKey;
        const remainingCount = item.tiles.length - chosenIndices.length;

        return `
          <div class="wr-reorder-row ${isActiveRow ? "active-row" : ""}" data-wr-reorder-row="${escapeHtml(ansKey)}">
            <div class="wr-reorder-line">
              <span class="wr-item-idx ${chosenIndices.length > 0 ? "filled" : ""}">${item.num}</span>
              <div class="wr-reorder-slot ${chosenIndices.length === 0 ? "empty" : ""} ${statusCls}">
                ${chosenIndices.length === 0 ? `<span class="wr-reorder-placeholder">Bấm các thẻ từ bên dưới theo đúng thứ tự</span>` : ""}
                ${chosenIndices
                  .map(
                    (tileIdx, pos) => `
                  <button type="button" class="wr-placed-tile" data-wr-remove-tile="${escapeHtml(ansKey)}" data-wr-tile-pos="${pos}" data-wr-parent="${escapeHtml(exKey)}" title="Bấm để bỏ từ này">
                    ${escapeHtml(item.tiles[tileIdx])}
                  </button>
                `
                  )
                  .join("")}
              </div>
            </div>

            ${
              remainingCount > 0
                ? `
              <div class="wr-tiles-pool">
                ${item.tiles
                  .map((word, idx) => {
                    const used = chosenIndices.includes(idx);
                    return `
                      <button type="button" class="wr-tile-btn ${used ? "used" : ""}" data-wr-add-tile="${escapeHtml(ansKey)}" data-wr-tile-idx="${idx}" data-wr-parent="${escapeHtml(exKey)}" ${used ? "disabled" : ""}>
                        ${escapeHtml(word)}
                      </button>
                    `;
                  })
                  .join("")}
              </div>
            `
                : ""
            }

            ${
              isChecked
                ? `<div class="wr-reorder-fb ${isCorrect ? "ok" : "err"}">${isCorrect ? "✓ Chính xác!" : `✗ Câu đúng: "${escapeHtml(item.answer)}"`}</div>`
                : ""
            }
          </div>
        `;
      })
      .join("");
  }

  function renderWritingCorrectionPanelHtml(unit, ex, isChecked, localWc) {
    const sub = getCloudWritingSubmission(unit.id);
    const releasedReview = getReleasedWritingReview(unit.id);
    const submitErr = cloudState.submitErrorByUnitId[unit.id] || "";
    const blocks = [];

    if (submitErr) {
      blocks.push(`<div class="auth-msg-err" style="margin-top:10px;margin-bottom:0;">⚠️ Lỗi đồng bộ bài lên hệ thống: ${escapeHtml(submitErr)}</div>`);
    }

    if (sub && sub.is_submitted) {
      const fmtTime = CLOUD ? CLOUD.formatDateTime : formatDateTime;
      const submittedTime = fmtTime(sub.submitted_at || sub.updated_at || sub.created_at);
      const hasTeacherFb = Boolean(sub.teacher_feedback && sub.teacher_feedback.trim());

      if (hasTeacherFb) {
        blocks.push(`
          <div class="writing-teacher-feedback-box">
            <div class="writing-tf-head">
              <span class="writing-tf-title">👨‍🏫 Nhận xét từ Giáo viên${submittedTime ? ` · Đã nộp ${escapeHtml(submittedTime)}` : ""}</span>
            </div>
            <p class="writing-tf-comment">${escapeHtml(sub.teacher_feedback)}</p>
          </div>
        `);
      }

      if (releasedReview && CLOUD && typeof CLOUD.renderWritingReviewHtml === "function") {
        const relTime = fmtTime(releasedReview.release_at);
        blocks.push(`
          <div class="writing-teacher-feedback-box">
            <div class="writing-tf-head">
              <span class="writing-tf-title">✅ Bài sửa chi tiết đã sẵn sàng${relTime ? ` · Trả lúc ${escapeHtml(relTime)}` : ""}</span>
              <span class="writing-tf-meta">${escapeHtml(String(sub.word_count || localWc || 0))} từ</span>
            </div>
          </div>
          ${CLOUD.renderWritingReviewHtml(sub.content || "", releasedReview.review_json)}
        `);
      } else {
        const releaseAt =
          sub.ai_release_at ||
          (sub.submitted_at ? new Date(new Date(sub.submitted_at).getTime() + 12 * 60 * 60 * 1000).toISOString() : "");
        const remainText = CLOUD && releaseAt ? CLOUD.formatRemainingTime(releaseAt) : "";
        const releaseFormatted = releaseAt ? fmtTime(releaseAt) : "";

        if (remainText) {
          blocks.push(`
            <div class="writing-schedule-box">
              <div class="writing-schedule-head">
                <span class="writing-schedule-title">⏳ Đã nộp bài thành công${submittedTime ? ` lúc ${escapeHtml(submittedTime)}` : ""} · Đang chờ trả bài sửa</span>
                <span class="writing-schedule-pill">Còn ${escapeHtml(remainText)}</span>
              </div>
              <p class="writing-schedule-desc">
                Bài sửa lỗi chi tiết (ngữ pháp, chính tả, dấu câu, từ vựng &amp; gợi ý ý) sẽ được gửi vào tài khoản của bạn sau <strong>12 tiếng</strong> — dự kiến lúc <strong>${escapeHtml(releaseFormatted)}</strong>. Bạn sẽ nhận được thông báo ở biểu tượng chuông 🔔 trên góc phải khi có bài sửa.
              </p>
            </div>
          `);
        } else if (!hasTeacherFb) {
          blocks.push(`
            <div class="writing-teacher-feedback-box">
              <div class="writing-tf-head">
                <span class="writing-tf-title">✓ Đã gửi bài viết thành công${submittedTime ? ` lúc ${escapeHtml(submittedTime)}` : ""}</span>
                <span class="writing-tf-meta">${escapeHtml(String(sub.word_count || localWc || 0))} từ</span>
              </div>
              <p class="writing-tf-comment">Bài sửa lỗi chi tiết của bạn đang được hoàn tất. Thông báo sẽ tự động hiện ở biểu tượng chuông 🔔 trên góc phải ngay khi bài sửa sẵn sàng.</p>
            </div>
          `);
        }
      }
    } else if (isChecked) {
      blocks.push(`
        <div class="writing-schedule-box">
          <div class="writing-schedule-head">
            <span class="writing-schedule-title">✓ Đã lưu bài viết (${localWc} từ)</span>
          </div>
          <p class="writing-schedule-desc">
            Đăng nhập bằng tài khoản học viên để hệ thống tự động sửa lỗi chi tiết và trả bài sau 12 tiếng.
          </p>
        </div>
      `);
    }

    if ((sub && sub.is_submitted) || isChecked) {
      if (ex.sampleAnswer) {
        blocks.push(`
          <details class="wr-sample-details">
            <summary class="wr-sample-summary">📖 Xem bài mẫu tham khảo</summary>
            <div class="wr-sample-body">${escapeHtml(ex.sampleAnswer)}</div>
          </details>
        `);
      }
    }

    return blocks.join("");
  }

  function renderWritingSingleExerciseCard(ex, secKey, prog, unit) {
    const exKey = `${secKey}__${ex.id}`;
    const safeExKey = domSafeId(exKey);
    const isChecked = Boolean(prog.checkedExercises[exKey]);
    const items = ex.items || [];

    if (ex.type === "writing") {
      const ansKey = `${exKey}_1`;
      const val = prog.exerciseAnswers[ansKey] || "";
      const wc = countWords(val);
      const { minW, maxW } = getWritingWordLimits(ex);
      const needed = Math.max(0, minW - wc);
      const canSubmit = wc >= minW;
      const isSubmitting = unit && cloudState.submittingUnitId === unit.id;
      const hasSubmitted = Boolean((unit && getCloudWritingSubmission(unit.id)) || isChecked);

      return `
        <article class="wr-ex-card" data-wr-ex-key="${escapeHtml(exKey)}" data-wr-total="1">
          <header class="wr-ex-header">
            <div class="wr-ex-head-left">
              <span class="wr-ex-num-pill">${escapeHtml(ex.id)}</span>
              <div>
                <h3 class="wr-ex-title">${escapeHtml(ex.title)}</h3>
                <div class="wr-ex-instr">${escapeHtml(ex.instruction)}</div>
              </div>
            </div>
            ${
              ex.partTag
                ? `<button type="button" class="wr-ex-part-tag" data-wr-jump-theory="${escapeHtml(ex.partTag)}">📖 ${escapeHtml(ex.partTag)}</button>`
                : ""
            }
          </header>

          <div class="wr-ex-body">
            ${ex.promptBox ? `<div class="wr-prompt-box">${escapeHtml(ex.promptBox)}</div>` : ""}
            <textarea
              rows="9"
              maxlength="10000"
              spellcheck="false"
              placeholder="Viết bài của bạn ở đây..."
              class="wr-writing-textarea"
              data-wr-writing-key="${escapeHtml(ansKey)}"
              data-wr-parent="${escapeHtml(exKey)}"
              data-wr-ex-id="${escapeHtml(ex.id)}"
              data-wr-min-words="${minW}"
              data-wr-max-words="${maxW}"
            >${escapeHtml(val)}</textarea>
            <div class="wr-counter-row">
              <span class="wr-wc-num" id="wr-wc-${safeExKey}">${wc} từ</span>
              <span>Yêu cầu ${minW}–${maxW} từ</span>
            </div>
            ${unit ? renderWritingCorrectionPanelHtml(unit, ex, isChecked, wc) : ""}
          </div>

          <footer class="wr-ex-footer">
            <span class="wr-status-text ${canSubmit ? "ready" : ""}" id="wr-status-${safeExKey}">
              ${canSubmit ? `${wc}/${minW} từ · Đủ điều kiện nộp bài` : `${wc}/${minW} từ · cần thêm ${needed} từ để nộp`}
            </span>
            <div style="display:flex;gap:8px;">
              ${hasSubmitted ? `<button type="button" class="nb-back-btn wr-mini-btn" data-wr-reset="${escapeHtml(exKey)}">Viết lại</button>` : ""}
              <button
                type="button"
                class="wr-check-btn ${!canSubmit && !hasSubmitted ? "unanswered" : ""}"
                id="wr-check-${safeExKey}"
                data-wr-check="${escapeHtml(exKey)}"
                data-wr-is-writing="1"
                data-wr-ex-id="${escapeHtml(ex.id)}"
                ${(!canSubmit && !hasSubmitted) || isSubmitting ? "disabled" : ""}
              >${isSubmitting ? "Đang gửi bài..." : hasSubmitted ? "Nộp bản sửa mới" : "Nộp bài sửa lỗi"}</button>
            </div>
          </footer>
        </article>
      `;
    }

    let answeredCount = 0;
    items.forEach(item => {
      const val = prog.exerciseAnswers[`${exKey}_${item.num}`];
      if (Array.isArray(val) ? val.length > 0 : val !== undefined && String(val).trim() !== "") {
        answeredCount++;
      }
    });

    return `
      <article class="wr-ex-card" data-wr-ex-key="${escapeHtml(exKey)}" data-wr-total="${items.length}">
        <header class="wr-ex-header">
          <div class="wr-ex-head-left">
            <span class="wr-ex-num-pill">${escapeHtml(ex.id)}</span>
            <div>
              <h3 class="wr-ex-title">${escapeHtml(ex.title)}</h3>
              <div class="wr-ex-instr">${escapeHtml(ex.instruction)}</div>
            </div>
          </div>
          ${
            ex.partTag
              ? `<button type="button" class="wr-ex-part-tag" data-wr-jump-theory="${escapeHtml(ex.partTag)}">📖 ${escapeHtml(ex.partTag)}</button>`
              : ""
          }
        </header>

        <div class="wr-ex-body">
          ${ex.type === "matching" ? renderWrMatchingExercise(ex, exKey, prog, isChecked) : ""}
          ${ex.type === "mcq" ? renderWrMcqExercise(ex, exKey, prog, isChecked) : ""}
          ${ex.type === "tf" ? renderWrTfExercise(ex, exKey, prog, isChecked) : ""}
          ${ex.type === "fill" ? renderWrFillExercise(ex, exKey, prog, isChecked) : ""}
          ${ex.type === "rewrite" ? renderWrRewriteExercise(ex, exKey, prog, isChecked) : ""}
          ${ex.type === "reorder" ? renderWrReorderExercise(ex, exKey, prog, isChecked) : ""}
        </div>

        <footer class="wr-ex-footer">
          <span class="wr-done-status" id="wr-status-${safeExKey}">Đã làm ${answeredCount}/${items.length}</span>
          <div style="display:flex;gap:8px;">
            ${isChecked ? `<button type="button" class="nb-back-btn wr-mini-btn" data-wr-reset="${escapeHtml(exKey)}">Làm lại</button>` : ""}
            <button
              type="button"
              class="wr-check-btn ${answeredCount === 0 && !isChecked ? "unanswered" : ""}"
              id="wr-check-${safeExKey}"
              data-wr-check="${escapeHtml(exKey)}"
            >Kiểm tra</button>
          </div>
        </footer>
      </article>
    `;
  }

  function renderWritingLessonView() {
    const unit = getCurrentWritingUnit();
    if (!unit) return renderWritingHubView();
    const prog = ensureWritingUnitProgress(unit.id);
    const secKey = state.currentWritingSection || "vocabulary";
    const secMeta = WRITING_SECTIONS.find(s => s.key === secKey) || WRITING_SECTIONS[0];
    const secObj = unit.sections[secKey];
    const partsMap = (secObj && secObj.parts) || {};
    const partKeys = Object.keys(partsMap);
    const activePartKey = partKeys.includes(state.currentWritingPart) ? state.currentWritingPart : partKeys[0] || "A";
    const activePart = partsMap[activePartKey];
    const exercisesList = getWritingSectionExercises(secObj, activePartKey);
    const doneExercisesCount = exercisesList.filter(ex => prog.checkedExercises[`${secKey}__${ex.id}`]).length;
    const hasMultipleParts = partKeys.length > 1;
    const secDoneTotal = getWritingUnitDoneSectionsCount(unit.id);
    const isFirstStep = secKey === "vocabulary" && partKeys.indexOf(activePartKey) <= 0;
    const lastPart = partsMap[partKeys[partKeys.length - 1]];
    const nextStepLabel =
      secObj && secObj.allExercisesInOneList
        ? (lastPart && lastPart.nextLabel) || "Phần tiếp theo →"
        : (activePart && activePart.nextLabel) || "Phần tiếp theo →";

    return `
      <main class="practice-workspace" style="flex:1;min-height:0;">
        <!-- LEFT PANE: WRITING THEORY (VOCABULARY / PHRASES / WRITING GUIDE) -->
        <section class="left-pane" id="wr-theory-pane" aria-label="Lý thuyết Writing">
          <div class="left-pane-inner wr-pane-inner">
            <div class="wr-pane-bar">
              <div class="wr-pane-bar-title">
                <span class="wr-pane-step">Phần ${secMeta.num}</span>
                <strong>${escapeHtml(secMeta.label)}</strong>
                <span class="wr-pane-sub">· ${escapeHtml(secMeta.labelVi)}</span>
              </div>
              ${
                hasMultipleParts
                  ? `
                <div class="wr-part-pills">
                  ${partKeys
                    .map(pk => {
                      const pObj = partsMap[pk];
                      return `
                        <button
                          type="button"
                          class="wr-part-pill-btn ${pk === activePartKey ? "active" : ""}"
                          data-wr-part="${escapeHtml(pk)}"
                          title="Part ${escapeHtml(pk)}: ${escapeHtml(pObj ? pObj.titleEn : "")}"
                        >Part ${escapeHtml(pk)}</button>
                      `;
                    })
                    .join("")}
                </div>
              `
                  : ""
              }
            </div>

            <div class="wr-theory-stack">
              ${partKeys
                .map(pk =>
                  renderWritingSinglePartTheoryHtml(partsMap[pk], unit, secMeta.label, pk === activePartKey, hasMultipleParts)
                )
                .join('<hr class="wr-part-divider" />')}
            </div>
          </div>
        </section>

        <!-- RIGHT PANE: INTERACTIVE EXERCISES & WRITING TASK -->
        <aside class="right-pane" id="wr-exercises-pane" aria-label="Bài tập thực hành Writing">
          <div class="right-pane-inner wr-pane-inner">
            <div class="wr-pane-bar">
              <div class="wr-pane-bar-title">
                <strong>Bài tập · ${escapeHtml(secMeta.label)}</strong>
                ${hasMultipleParts && !(secObj && secObj.allExercisesInOneList) ? `<span class="wr-pane-sub">· Part ${escapeHtml(activePartKey)}</span>` : ""}
              </div>
              <span class="wr-pane-counter">Đã kiểm tra ${doneExercisesCount}/${exercisesList.length}</span>
            </div>

            <div class="wr-exercises-stack">
              ${
                exercisesList.length === 0
                  ? `<div class="wr-ex-card"><div class="wr-ex-body" style="color:#52525B;">Không có bài tập ở mục này. Bấm tiếp theo ở góc dưới bên phải để chuyển phần.</div></div>`
                  : exercisesList.map(ex => renderWritingSingleExerciseCard(ex, secKey, prog, unit)).join("")
              }
            </div>
          </div>
        </aside>
      </main>

      <nav class="practice-bottom-nav" aria-label="Điều hướng bài học Writing">
        <div class="bottom-q-pills">
          <span class="bottom-part-text">Unit ${escapeHtml(unit.number)}</span>
          ${WRITING_SECTIONS.map(s => {
            const isAct = s.key === secKey;
            const isDone = prog.completedSections.includes(s.key);
            return `
              <button
                type="button"
                class="q-pill-btn wr-bottom-sec-pill ${isAct ? "active" : ""} ${isDone ? "done" : ""}"
                data-wr-section="${s.key}"
                title="${escapeHtml(s.num + ". " + s.label)}"
              >${s.num}. ${escapeHtml(s.label)}</button>
            `;
          }).join("")}
          <span class="bottom-q-counter">Đã học ${secDoneTotal}/3 phần</span>
        </div>

        <div class="stepper-row">
          <button type="button" class="btn-prev-q" id="btn-wr-prev" ${isFirstStep ? "disabled" : ""}>
            ← Phần trước
          </button>
          <button type="button" class="btn-next-q" id="btn-wr-next">
            ${escapeHtml(nextStepLabel)}
          </button>
        </div>
      </nav>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 2: CORE THEORY MODULE (PHẦN 1) + INTERACTIVE MINI QUIZ
  // --------------------------------------------------------------------------
  function renderTheoryView() {
    const stu = getActiveStudent();
    const quizState = stu.theoryQuiz || { answers: {}, submitted: false, score: 0 };

    return `
      <main class="home-container">
        <div style="margin-bottom:14px;">
          <button type="button" class="nb-back-btn" data-sb-nav="home">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            <span>Quay lại 3 phần chính</span>
          </button>
        </div>

        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">PHẦN 1 · LÝ THUYẾT CỐT LÕI (TRANG 1–2)</div>
            <h1 class="home-h1">NGẮN GỌN, DỄ NHỚ, DỄ ÁP DỤNG NGAY</h1>
            <p class="home-desc">
              Nắm chắc 5 nội dung cốt lõi dưới đây trước khi làm bài tập. Cuối trang có 5 câu trắc nghiệm nhanh để em kiểm tra xem mình đã nhớ đúng chiến thuật chưa!
            </p>
          </div>
        </div>

        <!-- 1. Hiểu đúng về IELTS Reading trong 1 phút -->
        <section class="theory-card">
          <h2 class="theory-card-title">
            <span class="topic-num-badge" style="width:32px;height:32px;font-size:13px;">1</span>
            Hiểu đúng về bài thi IELTS Reading trong 1 phút
          </h2>

          <div class="theory-metrics-grid">
            ${THEORY.metrics
              .map(
                m => `
                <div class="theory-metric-card">
                  <div class="theory-metric-big">${escapeHtml(m.big)}</div>
                  <div style="font-size:13.8px;font-weight:800;color:#18181B;margin-bottom:4px;">${escapeHtml(m.title)}</div>
                  <p style="font-size:12.8px;color:#3F3F46;line-height:1.55;">${escapeHtml(m.desc)}</p>
                </div>
              `
              )
              .join("")}
          </div>

          <div class="theory-callout-good">
            <strong>💡 Lưu ý cho mục tiêu Band 5.0–6.0: Em không cần làm đúng hết 40 câu.</strong><br />
            Đề thi luôn có những câu khó để phân loại Band 8.0–9.0. Với mục tiêu <strong>5.0 – 6.0</strong>, em không cần dịch hiểu 100% bài đọc mà nên tập trung làm chắc các câu vừa sức.
          </div>

          <div class="vocab-table-wrap">
            <table class="vocab-table">
              <thead>
                <tr>
                  <th style="width:120px;">Mục tiêu Band</th>
                  <th style="width:190px;">Số câu đúng / 40 câu</th>
                  <th>Chiến thuật làm bài phù hợp</th>
                </tr>
              </thead>
              <tbody>
                ${THEORY.bandTargets
                  .map(
                    b => `
                    <tr>
                      <td><strong>Band ${escapeHtml(b.band)}</strong></td>
                      <td><strong style="font-family:var(--font-mono);color:#15803D;">${escapeHtml(b.correctRange)}</strong></td>
                      <td>${escapeHtml(b.strategy)}</td>
                    </tr>
                  `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>

        <!-- 2. Phương pháp 2 bước TÌM & HIỂU -->
        <section class="theory-card">
          <h2 class="theory-card-title">
            <span class="topic-num-badge" style="width:32px;height:32px;font-size:13px;">2</span>
            Phương pháp cốt lõi: Tránh đọc lướt vội vàng, áp dụng 2 bước "TÌM &amp; HIỂU"
          </h2>
          <p style="font-size:13.8px;color:#3F3F46;line-height:1.6;margin-bottom:12px;">
            Nếu áp dụng Skimming &amp; Scanning (đọc lướt quá nhanh), người học rất dễ bỏ sót thông tin và lướt qua từ đồng nghĩa (VD: câu hỏi dùng <strong>buy</strong>, bài đọc viết <strong>purchase</strong>).
          </p>

          <div class="topics-grid">
            ${THEORY.methodSteps
              .map(
                s => `
                <div style="border:2px solid #18181B;border-radius:9px;padding:15px 17px;background:#FAF9F6;">
                  <span class="strategy-step-num">${escapeHtml(s.step)}</span>
                  <div style="font-size:16px;font-weight:900;color:#18181B;margin-bottom:6px;">${escapeHtml(s.title)}</div>
                  <p style="font-size:13.5px;line-height:1.6;color:#27272A;margin-bottom:10px;">${escapeHtml(s.desc)}</p>
                  <div style="font-size:12.6px;line-height:1.55;padding:9px 11px;background:#FFFBEB;border:1px solid #F59E0B;border-radius:6px;color:#78350F;">
                    ${escapeHtml(s.exception)}
                  </div>
                </div>
              `
              )
              .join("")}
          </div>
        </section>

        <!-- 3. Năm nguyên tắc quan trọng -->
        <section class="theory-card">
          <h2 class="theory-card-title">
            <span class="topic-num-badge" style="width:32px;height:32px;font-size:13px;">3</span>
            Năm nguyên tắc quan trọng giúp quản lý thời gian hiệu quả
          </h2>
          <div class="principles-grid">
            ${THEORY.principles
              .map(
                p => `
                <div class="principle-item">
                  <span class="principle-num">NGUYÊN TẮC ${escapeHtml(p.num)}</span>
                  <div style="font-size:14.2px;font-weight:800;color:#18181B;margin-bottom:5px;">${escapeHtml(p.title)}</div>
                  <p style="font-size:13px;line-height:1.6;color:#3F3F46;">${escapeHtml(p.desc)}</p>
                </div>
              `
              )
              .join("")}
          </div>
        </section>

        <!-- 4. Cách tự luyện ở nhà & Keyword Table -->
        <section class="theory-card">
          <h2 class="theory-card-title">
            <span class="topic-num-badge" style="width:32px;height:32px;font-size:13px;">4</span>
            Cách tự luyện ở nhà giúp tăng điểm nhanh nhất
          </h2>
          <div class="topics-grid" style="margin-bottom:14px;">
            ${THEORY.selfStudyTips
              .map(
                t => `
                <div style="background:#FAF9F6;border:1.5px solid #18181B;border-radius:8px;padding:13px 15px;">
                  <div style="font-size:14px;font-weight:800;color:#18181B;margin-bottom:4px;">✓ ${escapeHtml(t.title)}</div>
                  <p style="font-size:13px;line-height:1.6;color:#3F3F46;">${escapeHtml(t.desc)}</p>
                </div>
              `
              )
              .join("")}
          </div>

          <div style="font-size:13px;font-weight:800;margin-bottom:7px;">📊 Mẫu Bảng Từ Khoá (Keyword Table) — Bấm vào từ để nghe phát âm &amp; Lưu vào kho:</div>
          ${renderKeywordTableHtml(THEORY.introKeywordExamples, "Phần 1 · Lý thuyết")}
        </section>

        <!-- 5. Bảng so sánh 2 dạng bài -->
        <section class="theory-card">
          <h2 class="theory-card-title">
            <span class="topic-num-badge" style="width:32px;height:32px;font-size:13px;">5</span>
            Bảng so sánh nhanh 2 dạng bài mở đầu dễ lấy điểm nhất
          </h2>
          <div class="vocab-table-wrap">
            <table class="vocab-table">
              <thead>
                <tr>
                  <th style="width:180px;">Tiêu chí</th>
                  <th>DẠNG 1: GAP-FILLING (Điền từ)</th>
                  <th>DẠNG 2: MATCHING NAMES (Nối tên)</th>
                </tr>
              </thead>
              <tbody>
                ${THEORY.comparisonRows
                  .map(
                    r => `
                    <tr>
                      <td><strong>${escapeHtml(r.criteria)}</strong></td>
                      <td>${escapeHtml(r.gapFill)}</td>
                      <td>${escapeHtml(r.matching)}</td>
                    </tr>
                  `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>

        <!-- Interactive Mini Quiz -->
        <section class="theory-card" id="theory-quiz-section" style="background:#FFFDF9;">
          <h2 class="theory-card-title">
            <span class="topic-num-badge" style="width:32px;height:32px;font-size:13px;">✓</span>
            Mini Quiz Kiểm Tra Nhanh Lý Thuyết (5 câu)
          </h2>
          <p style="font-size:13.5px;color:#52525B;margin-bottom:14px;">
            Làm nhanh 5 câu này để chắc chắn em đã nắm vững quy luật làm bài trước khi vào 8 bài đọc thực hành nhé!
          </p>

          ${THEORY.quickQuiz
            .map((q, idx) => {
              const chosen = quizState.answers[q.id];
              return `
                <div style="margin-bottom:14px;padding:13px 15px;background:#FFFFFF;border:1.5px solid #18181B;border-radius:8px;">
                  <div style="font-size:14px;font-weight:800;color:#18181B;margin-bottom:8px;">
                    Câu ${idx + 1}. ${escapeHtml(q.question)}
                  </div>
                  <div style="display:flex;flex-direction:column;gap:6px;">
                    ${q.options
                      .map((opt, optIdx) => {
                        let cls = "theory-quiz-option";
                        if (quizState.submitted) {
                          if (optIdx === q.correctIndex) cls += " correct";
                          else if (chosen === optIdx) cls += " wrong";
                        } else if (chosen === optIdx) {
                          cls += " selected";
                        }
                        return `
                          <button type="button" class="${cls}" data-tq-id="${q.id}" data-tq-opt="${optIdx}">
                            ${String.fromCharCode(65 + optIdx)}. ${escapeHtml(opt)}
                          </button>
                        `;
                      })
                      .join("")}
                  </div>
                  ${
                    quizState.submitted
                      ? `<div class="q-explanation-box ${chosen === q.correctIndex ? "" : "wrong-exp"}">${escapeHtml(q.explain)}</div>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}

          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:12px;">
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button type="button" class="submit-take-btn" id="btn-submit-theory-quiz">
                ${quizState.submitted ? `✓ Kết quả: ${quizState.score}/5 câu — Bấm chấm lại` : "Kiểm tra kết quả Quiz →"}
              </button>
              ${
                quizState.submitted
                  ? `<button type="button" class="nb-back-btn" id="btn-reset-theory-quiz">Làm lại Quiz</button>`
                  : ""
              }
            </div>
            <button type="button" class="top-pill-btn yellow" data-open-part="gap-filling">
              <span>Tiếp tục sang Dạng 1: Gap-filling →</span>
            </button>
          </div>
        </section>
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 3: PART TOPICS (GAP-FILLING / MATCHING NAMES) + STRATEGY BANNER
  // --------------------------------------------------------------------------
  function renderPartTopicsView() {
    const stu = getActiveStudent();
    const partId = state.selectedPart || "gap-filling";
    const guide = GUIDES[partId];
    const exList = getExercisesByPart(partId);

    return `
      <main class="home-container">
        <div style="margin-bottom:14px;">
          <button type="button" class="nb-back-btn" data-sb-nav="reading-hub">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            <span>Quay lại Reading</span>
          </button>
        </div>

        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">IELTS READING · ${escapeHtml(getPartMeta(partId).eyebrow)}</div>
            <h1 class="home-h1">${escapeHtml(guide.title.toUpperCase())}</h1>
            <p class="home-desc">${escapeHtml(guide.subtitle)}</p>
          </div>
        </div>

        <!-- Universal Strategy Banner (matching VSTEP Speaking Part 2 Outline Banner) -->
        <section class="p2-outline-banner">
          <div class="p2-outline-head">
            <div>
              <h2 class="topic-card-title" style="margin-bottom:0;">Khung Chiến Thuật 4 Bước &amp; Ví Dụ Giải Mẫu</h2>
            </div>
            <button type="button" class="top-pill-btn yellow" id="btn-toggle-worked-ans">
              ${state.workedExampleShowAnswers ? "👁️ Ẩn đáp án ví dụ mẫu" : "👁️ Hiện đáp án & giải thích mẫu"}
            </button>
          </div>

          <div class="p2-outline-list">
            <div class="topics-grid" style="gap:12px;">
              ${guide.groups
                .map(
                  g => `
                  <div style="background:#FFFFFF;border:1.5px solid #E4E4E7;border-radius:7px;padding:11px 14px;">
                    <div style="font-size:13.2px;font-weight:800;color:#18181B;margin-bottom:6px;">${escapeHtml(g.title)}</div>
                    <ul style="padding-left:18px;font-size:12.8px;line-height:1.6;color:#3F3F46;display:flex;flex-direction:column;gap:4px;">
                      ${g.bullets.map(b => `<li>${b}</li>`).join("")}
                    </ul>
                  </div>
                `
                )
                .join("")}
            </div>

            <div class="strategy-steps-grid">
              ${guide.steps
                .map(
                  st => `
                  <div class="strategy-step-box">
                    <span class="strategy-step-num">${escapeHtml(st.num)}</span>
                    <div class="strategy-step-title">${escapeHtml(st.title)}</div>
                    <div class="strategy-step-desc">${escapeHtml(st.desc)}</div>
                  </div>
                `
                )
                .join("")}
            </div>

            <div class="worked-example-box">
              <div style="font-size:13px;font-weight:900;color:#18181B;">
                🔍 ${escapeHtml(guide.workedExample.title)}
              </div>
              <div class="worked-passage">${guide.workedExample.passageHtml}</div>
              <div style="display:flex;flex-direction:column;gap:7px;">
                ${guide.workedExample.items
                  .map(
                    it => `
                    <div style="font-size:13px;line-height:1.55;padding:7px 10px;background:#FAF9F6;border:1px solid #E4E4E7;border-radius:6px;">
                      <strong>${it.num}.</strong> ${escapeHtml(it.question)}
                      ${
                        state.workedExampleShowAnswers
                          ? `<div style="margin-top:4px;color:#15803D;"><strong>→ Đáp án: ${escapeHtml(it.answer)}</strong> <span style="color:#3F3F46;">(${escapeHtml(it.why)})</span></div>`
                          : ""
                      }
                    </div>
                  `
                  )
                  .join("")}
              </div>
            </div>
          </div>
        </section>

        <!-- 4 Practice Exercises Grid -->
        <div class="topics-grid">
          ${exList
            .map(ex => {
              const exState = stu.exercises[ex.id];
              const isDone = Boolean(exState && exState.submitted);
              const pct = isDone && exState.total ? Math.round((exState.score / exState.total) * 100) : 0;

              return `
                <article class="topic-card" data-open-exercise="${escapeHtml(ex.id)}">
                  <div class="topic-card-top">
                    <div class="topic-num-badge">${escapeHtml(ex.number)}</div>
                    <span class="topic-progress-tag ${isDone ? "done" : ""}">
                      ${isDone ? `Đã nộp · ${exState.score}/${exState.total} (${pct}%) ✓` : `${ex.questions.length} câu hỏi · ${ex.recommendedMinutes} phút`}
                    </span>
                  </div>

                  <h2 class="topic-card-title">${escapeHtml(ex.title)}</h2>
                  <div class="topic-card-vi">${escapeHtml(ex.titleVi)}</div>
                  <p class="topic-card-desc">${escapeHtml(ex.description)}</p>

                  <ul class="topic-questions-preview">
                    <li><span class="preview-q-num">Dạng:</span><span><strong>${escapeHtml(ex.badge)}</strong></span></li>
                    <li><span class="preview-q-num">Luật:</span><span>${escapeHtml(ex.wordLimitLabel)}${ex.nbReuse ? " · <strong>Có NB dùng lặp!</strong>" : ""}</span></li>
                    <li><span class="preview-q-num">Hỗ trợ:</span><span>Dịch từng câu, Quét tên/số, Gợi ý loại từ &amp; Bảng Keyword Table</span></li>
                  </ul>

                  <div class="topic-card-footer">
                    <span>${ex.supportVocab.length} từ vựng + ${ex.keywordTable.length} cặp đồng nghĩa</span>
                    <span>${isDone ? "Xem lại / Làm lại →" : "Vào luyện đề →"}</span>
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // SHARED KEYWORD TABLE & VOCAB TABLE RENDERERS
  // --------------------------------------------------------------------------
  function renderKeywordTableHtml(rows, sourceLabel) {
    const stu = getActiveStudent();
    return `
      <div class="vocab-table-wrap">
        <table class="vocab-table">
          <thead>
            <tr>
              <th>Từ trong Câu hỏi (Question)</th>
              <th>Từ tương đương trong Bài đọc (Passage)</th>
              <th>Nghĩa tiếng Việt</th>
              <th style="width:120px;">Lưu kho</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(row => {
                const keyWord = `${row.q} ↔ ${row.p}`;
                const isSaved = stu.savedVocab.some(v => v.word.toLowerCase() === keyWord.toLowerCase());
                return `
                  <tr>
                    <td>
                      <button type="button" class="vocab-word-click-btn" data-speak-word="${escapeHtml(row.q)}">
                        <span>🔊</span><span>${escapeHtml(row.q)}</span>
                      </button>
                    </td>
                    <td>
                      <button type="button" class="vocab-word-click-btn" data-speak-word="${escapeHtml(row.p)}" style="color:#15803D;">
                        <span>🔊</span><span>${escapeHtml(row.p)}</span>
                      </button>
                      ${row.ipa ? `<span class="vocab-ipa-line">${escapeHtml(row.ipa)}</span>` : ""}
                    </td>
                    <td><strong>${escapeHtml(row.vi)}</strong></td>
                    <td>
                      <button
                        type="button"
                        class="vocab-save-mini-btn ${isSaved ? "saved" : ""}"
                        data-toggle-save-vocab="${escapeHtml(keyWord)}"
                        data-vocab-ipa="${escapeHtml(row.ipa || "")}"
                        data-vocab-pos="paraphrase"
                        data-vocab-meaning="${escapeHtml(row.vi)}"
                        data-vocab-example="Question: ${escapeHtml(row.q)} | Passage: ${escapeHtml(row.p)}"
                        data-vocab-topic="${escapeHtml(sourceLabel)}"
                      >
                        ${isSaved ? "✓ Đã lưu" : "+ Lưu kho"}
                      </button>
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 4: 50/50 SPLIT-SCREEN PRACTICE ROOM
  // --------------------------------------------------------------------------
  function renderInlineGapControl(ex, exState, q) {
    const val = exState.answers[q.id] || "";
    const showAns = exState.submitted;
    const evalRes = exState.submitted ? evaluateQuestion(ex, q, val) : null;

    let inputCls = "ielts-gap-input";
    if (ex.letterMode) inputCls += " letter-mode";
    if (evalRes) {
      inputCls += evalRes.isCorrect ? " is-correct" : " is-wrong";
    }

    // Real-time word-limit warning while typing
    let liveWarn = "";
    if (!exState.submitted && val.trim()) {
      if (ex.letterMode) {
        const up = val.trim().toUpperCase();
        if (!/^[A-H]$/.test(up)) {
          liveWarn = `<span class="word-limit-warning">⚠️ Chỉ ghi 1 chữ cái A–H!</span>`;
          inputCls += " limit-warn";
        }
      } else if (ex.maxWords && countWords(val) > ex.maxWords) {
        liveWarn = `<span class="word-limit-warning">⚠️ Lố từ! Tối đa ${ex.maxWords} từ</span>`;
        inputCls += " limit-warn";
      }
    }

    return `
      <span class="ielts-inline-gap-wrap">
        <span class="gap-num-badge">${q.num}</span>
        <input
          type="text"
          class="${inputCls}"
          data-gap-input="${escapeHtml(q.id)}"
          value="${escapeHtml(val)}"
          placeholder="${ex.letterMode ? "A–H" : `${ex.maxWords === 1 ? "1 từ..." : "1–2 từ..."}`}"
          ${exState.submitted ? "readonly" : ""}
        />
        ${liveWarn}
        ${
          showAns && (!evalRes || !evalRes.isCorrect)
            ? `<strong style="color:#15803D;font-size:12.5px;background:#DCFCE7;padding:2px 6px;border-radius:4px;">→ ${escapeHtml(q.displayAnswer)}</strong>`
            : ""
        }
      </span>
    `;
  }

  function renderQuestionSheetBody(ex, exState) {
    const qMap = {};
    ex.questions.forEach(q => { qMap[q.id] = q; });

    if (ex.formatType === "notes") {
      return `
        <div class="ielts-question-sheet">
          <div class="ielts-sheet-heading">${escapeHtml(ex.sheetTitle)}</div>
          ${ex.noteGroups
            .map(
              grp => `
              <div class="ielts-note-group-title">${escapeHtml(grp.heading)}</div>
              <ul class="ielts-note-list">
                ${grp.bullets
                  .map(b => {
                    if (b.staticText) return `<li>${escapeHtml(b.staticText)}</li>`;
                    const q = qMap[b.qId];
                    return `<li>${escapeHtml(b.before)} ${renderInlineGapControl(ex, exState, q)} ${escapeHtml(b.after)}</li>`;
                  })
                  .join("")}
              </ul>
            `
            )
            .join("")}
        </div>
      `;
    }

    if (ex.formatType === "table") {
      return `
        <div class="ielts-question-sheet">
          <div class="ielts-sheet-heading">${escapeHtml(ex.sheetTitle)}</div>
          <div class="vocab-table-wrap">
            <table class="vocab-table">
              <thead>
                <tr>
                  <th style="width:140px;">${escapeHtml(ex.tableHeaders[0])}</th>
                  <th>${escapeHtml(ex.tableHeaders[1])}</th>
                </tr>
              </thead>
              <tbody>
                ${ex.tableRows
                  .map(row => {
                    const q = qMap[row.qId];
                    return `
                      <tr>
                        <td><strong>${escapeHtml(row.col1)}</strong></td>
                        <td>${escapeHtml(row.before)} ${renderInlineGapControl(ex, exState, q)} ${escapeHtml(row.after)}</td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    if (ex.formatType === "summary" || ex.formatType === "summary-box") {
      return `
        <div class="ielts-question-sheet">
          <div class="ielts-sheet-heading">${escapeHtml(ex.sheetTitle)}</div>
          <p style="font-size:14.2px;line-height:2.05;color:#27272A;">
            ${ex.summaryParts
              .map(part => {
                if (part.text) return escapeHtml(part.text);
                return renderInlineGapControl(ex, exState, qMap[part.qId]);
              })
              .join("")}
          </p>

          ${
            ex.wordBox
              ? `
              <div style="margin-top:12px;font-size:12px;font-weight:800;color:#52525B;">
                Hộp từ A–H (Bấm vào ô trống trước rồi bấm thẻ chữ cái để điền nhanh, hoặc tự gõ A–H):
              </div>
              <div class="word-box-grid">
                ${ex.wordBox
                  .map(
                    wb => `
                    <button type="button" class="word-box-chip" data-pick-wordbox="${wb.letter}" title="Bấm để điền chữ cái ${wb.letter}">
                      <span class="word-box-letter">${wb.letter}</span>
                      <span>${escapeHtml(wb.word)}</span>
                    </button>
                  `
                  )
                  .join("")}
              </div>
            `
              : ""
          }
        </div>
      `;
    }

    if (ex.formatType === "mcq") {
      return `
        <div>
          ${ex.questions
            .map(q => {
              const rawVal = String(exState.answers[q.id] || "");
              const selectedList = rawVal
                .split(",")
                .map(s => s.trim().toUpperCase())
                .filter(Boolean);
              const evalRes = exState.submitted ? evaluateQuestion(ex, q, rawVal) : null;
              const rowCls = evalRes ? (evalRes.isCorrect ? "is-correct" : "is-wrong") : "";
              const isMulti = Boolean(q.selectCount && q.selectCount > 1);

              return `
                <div class="matching-q-row ${rowCls}">
                  <div class="matching-q-text">
                    <span class="gap-num-badge" style="margin-right:6px;">${q.num}</span>
                    ${escapeHtml(q.statement)}
                    ${
                      isMulti
                        ? `<span class="mcq-select-counter ${selectedList.length === q.selectCount ? "ready" : ""}">Đã chọn ${selectedList.length}/${q.selectCount}</span>`
                        : ""
                    }
                  </div>
                  <div class="mcq-options-list">
                    ${(q.options || [])
                      .map(opt => {
                        const isSel = selectedList.includes(opt.letter);
                        const isCorrectOpt = q.accepted.includes(opt.letter);
                        let optCls = "mcq-option-btn";
                        if (exState.submitted) {
                          if (isCorrectOpt) optCls += " is-correct-opt";
                          else if (isSel && !isCorrectOpt) optCls += " is-wrong-opt";
                        } else if (isSel) {
                          optCls += " selected";
                        }
                        return `
                          <button
                            type="button"
                            class="${optCls}"
                            data-mcq-qid="${escapeHtml(q.id)}"
                            data-mcq-letter="${opt.letter}"
                            data-mcq-max="${q.selectCount || 1}"
                            ${exState.submitted ? "disabled" : ""}
                          >
                            <span class="mcq-opt-letter">${opt.letter}</span>
                            <span>${escapeHtml(opt.text)}</span>
                          </button>
                        `;
                      })
                      .join("")}
                  </div>
                  ${
                    exState.submitted
                      ? `<div style="margin-top:8px;font-size:12px;font-weight:800;color:#15803D;">Đáp án chuẩn: ${escapeHtml(q.displayAnswer)}</div>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    }

    if (ex.formatType === "matching-info") {
      const paraLetters = ex.paragraphOptions || ex.paragraphs.map(p => p.label);
      return `
        <div>
          ${ex.questions
            .map(q => {
              const chosen = String(exState.answers[q.id] || "").toUpperCase();
              const evalRes = exState.submitted ? evaluateQuestion(ex, q, chosen) : null;
              const rowCls = evalRes ? (evalRes.isCorrect ? "is-correct" : "is-wrong") : "";

              return `
                <div class="matching-q-row ${rowCls}">
                  <div class="matching-q-text">
                    <span class="gap-num-badge" style="margin-right:6px;">${q.num}</span>
                    ${escapeHtml(q.statement)}
                  </div>
                  <div class="matching-letter-btns">
                    ${paraLetters
                      .map(letter => {
                        const isSel = chosen === letter;
                        const isRightReveal = exState.submitted && q.accepted.includes(letter);
                        return `
                          <button
                            type="button"
                            class="match-letter-btn ${isSel ? "selected" : ""} ${isRightReveal && !isSel ? "correct-choice" : ""}"
                            data-match-qid="${escapeHtml(q.id)}"
                            data-match-letter="${escapeHtml(letter)}"
                            ${exState.submitted ? "disabled" : ""}
                          >${escapeHtml(letter)}</button>
                        `;
                      })
                      .join("")}
                    ${
                      exState.submitted
                        ? `<span style="font-size:12px;font-weight:800;color:#15803D;margin-left:6px;">Đáp án: ${escapeHtml(q.displayAnswer)}</span>`
                        : ""
                    }
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    }

    // Matching Names format
    return `
      <div class="matching-list-box">
        <div class="matching-list-title">${escapeHtml(ex.listTitle)}</div>
        <div class="matching-options-grid">
          ${ex.matchingOptions
            .map(
              opt => `
              <div class="matching-option-item">
                <span class="word-box-letter">${opt.letter}</span>
                <span>${escapeHtml(opt.name)}</span>
              </div>
            `
            )
            .join("")}
        </div>
      </div>

      <div>
        ${ex.questions
          .map(q => {
            const chosen = String(exState.answers[q.id] || "").toUpperCase();
            const evalRes = exState.submitted ? evaluateQuestion(ex, q, chosen) : null;
            const rowCls = evalRes ? (evalRes.isCorrect ? "is-correct" : "is-wrong") : "";

            return `
              <div class="matching-q-row ${rowCls}">
                <div class="matching-q-text">
                  <span class="gap-num-badge" style="margin-right:6px;">${q.num}</span>
                  ${escapeHtml(q.statement)}
                </div>
                <div class="matching-letter-btns">
                  ${ex.matchingOptions
                    .map(opt => {
                      const isSel = chosen === opt.letter;
                      const isRightReveal = exState.submitted && q.accepted.includes(opt.letter);
                      return `
                        <button
                          type="button"
                          class="match-letter-btn ${isSel ? "selected" : ""} ${isRightReveal && !isSel ? "correct-choice" : ""}"
                          data-match-qid="${escapeHtml(q.id)}"
                          data-match-letter="${opt.letter}"
                          ${exState.submitted ? "disabled" : ""}
                        >${opt.letter}</button>
                      `;
                    })
                    .join("")}
                  ${
                    exState.submitted
                      ? `<span style="font-size:12px;font-weight:800;color:#15803D;margin-left:6px;">Đáp án: ${escapeHtml(q.displayAnswer)}</span>`
                      : ""
                  }
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderPracticeView() {
    const stu = getActiveStudent();
    const ex = getCurrentExercise();
    const exState = ensureExerciseState(ex.id);
    const samePartList = getExercisesByPart(ex.part);
    const exIdx = samePartList.findIndex(item => item.id === ex.id);
    const doneInPart = samePartList.filter(e => stu.exercises[e.id] && stu.exercises[e.id].submitted).length;

    const showFullExplanations = exState.submitted;

    const scorePct = exState.submitted && exState.total ? Math.round((exState.score / exState.total) * 100) : 0;
    let bannerTone = "";
    let bandEncourage = "";
    if (exState.submitted) {
      if (scorePct >= 80) {
        bannerTone = "";
        bandEncourage = "Xuất sắc! Tỷ lệ chính xác vượt chuẩn Band 6.0+ — hãy lưu thêm cặp từ đồng nghĩa bên dưới nhé!";
      } else if (scorePct >= 50) {
        bannerTone = "mid";
        bandEncourage = "Tốt lắm! Đạt đúng chuẩn mục tiêu Band 5.5–6.0. Em bấm 'Xem bằng chứng' ở câu sai để rút kinh nghiệm bẫy nhé!";
      } else {
        bannerTone = "low";
        bandEncourage = "Đừng nản nhé! Mới học sai nhiều là bình thường — hãy bấm 'Xem bằng chứng' ở từng câu để học ngược từ đáp án!";
      }
    }

    return `
      <main class="practice-workspace" style="flex:1;min-height:0;">
        <!-- LEFT PANE: INTERACTIVE READING PASSAGE -->
        <section class="left-pane" aria-label="Bài đọc tương tác">
          <div class="left-pane-inner">
            <div class="passage-toolbar">
              ${(() => {
                const activeSwatch = HIGHLIGHT_COLORS.find(c => c.key === state.highlightColor) || HIGHLIGHT_COLORS[0];
                const hasHl = hasAnyPassageHighlights(exState);
                return `
                <div class="hl-tool-group ${state.highlightToolActive ? "is-open" : ""}">
                  <button
                    type="button"
                    class="hl-main-btn ${state.highlightToolActive ? "active" : ""}"
                    id="btn-toggle-hl-tool"
                    title="Bôi đen đoạn bất kỳ hoặc bấm vào cả câu để highlight"
                  >
                    <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
                    <span>Gạch chân</span>
                    ${state.highlightToolActive ? `<span class="hl-active-dot" style="background:${activeSwatch.bg};"></span>` : ""}
                  </button>
                  ${
                    state.highlightToolActive
                      ? `
                    <span class="hl-divider" aria-hidden="true"></span>
                    <div class="hl-swatches" role="group" aria-label="Chọn màu highlight pastel">
                      ${HIGHLIGHT_COLORS.map(
                        c => `
                        <button
                          type="button"
                          class="hl-color-swatch ${state.highlightColor === c.key ? "active" : ""}"
                          data-hl-color="${c.key}"
                          title="${escapeHtml(c.label)}"
                          aria-label="${escapeHtml(c.label)}"
                          style="background:${c.bg};"
                        ></button>
                      `
                      ).join("")}
                    </div>
                    ${
                      hasHl
                        ? `
                      <span class="hl-divider" aria-hidden="true"></span>
                      <button type="button" class="hl-clear-icon-btn" id="btn-clear-highlights" title="Xoá toàn bộ highlight trong bài" aria-label="Xoá toàn bộ highlight">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                      </button>
                    `
                        : ""
                    }
                  `
                      : ""
                  }
                </div>
              `;
              })()}

              <button
                type="button"
                class="tool-toggle-btn ${state.scanHelperActive ? "active" : ""}"
                id="btn-toggle-scan"
                title="Đánh dấu nhanh Tên riêng (kể cả Họ) & Con số trong bài"
              >
                <span>🔍</span><span>Quét Tên &amp; Số</span>
              </button>

              <button
                type="button"
                class="tool-toggle-btn ${state.translateModeActive ? "active" : ""}"
                id="btn-toggle-translate"
                title="Bật chế độ bấm vào bất kỳ câu tiếng Anh nào để hiện nghĩa tiếng Việt"
              >
                <span>🌐</span><span>${state.translateModeActive ? "Đang bật Dịch câu" : "Dịch từng câu"}</span>
              </button>
            </div>

            <!-- Support Vocabulary Strip (above passage) -->
            <div class="support-vocab-box">
              <div style="font-size:12.5px;font-weight:800;color:#92400E;">
                📖 Từ vựng hỗ trợ trong bài (Bấm để nghe phát âm):
              </div>
              <div class="support-vocab-chips">
                ${ex.supportVocab
                  .map(
                    v => `
                    <button type="button" class="support-vocab-chip" data-speak-word="${escapeHtml(v.word)}">
                      <span>🔊</span>
                      <strong>${escapeHtml(v.word)}</strong>
                      <span style="color:#71717A;">=</span>
                      <span>${escapeHtml(v.meaning)}</span>
                    </button>
                  `
                  )
                  .join("")}
              </div>
            </div>

            <article class="passage-paper-card ${state.highlightToolActive ? "hl-mode-active" : ""}" id="passage-paper-card">
              <div style="font-family:var(--font-mono);font-size:11px;font-weight:800;color:#71717A;text-transform:uppercase;margin-bottom:4px;">
                ${escapeHtml(ex.badge)}
              </div>
              <h2 class="passage-title">${escapeHtml(ex.title)}</h2>

              ${ex.paragraphs
                .map(
                  para => `
                  <div class="passage-para">
                    <span class="para-label-badge ${para.noNames && state.scanHelperActive ? "skip-hint" : ""}" title="${para.noNames ? "Đoạn này không có tên riêng" : para.label}">
                      ${escapeHtml(para.label.replace("Đoạn ", "Đ"))}
                    </span>
                    <div style="flex:1;">
                      ${
                        para.noNames && state.scanHelperActive
                          ? `<div style="font-size:11.5px;font-weight:800;color:#B45309;margin-bottom:4px;">⏭ Mẹo Matching Names: Đoạn này KHÔNG CÓ TÊN RIÊNG → Có thể bỏ qua!</div>`
                          : ""
                      }
                      ${para.sentences
                        .map(sent => {
                          const hlColor = normalizeHighlightColor(
                            exState.highlightedSentences && exState.highlightedSentences[sent.id]
                          );
                          const isEv = state.activeEvidenceSentenceId === sent.id;
                          const isTransOpen = Boolean(state.revealedTranslations[sent.id]);
                          const clickable = state.highlightToolActive || state.translateModeActive;
                          return `<span
                            id="sent-${escapeHtml(sent.id)}"
                            class="passage-sentence ${clickable ? "translate-ready" : ""} ${hlColor ? `user-hl hl-${hlColor}` : ""} ${isEv ? "evidence-active" : ""}"
                            data-sentence-id="${escapeHtml(sent.id)}"
                          >${decorateSentenceText(sent.en, ex, sent.id, exState)}</span>${
                            isTransOpen ? `<span class="sent-vi-inline">${escapeHtml(sent.vi)}</span>` : ""
                          } `;
                        })
                        .join("")}
                    </div>
                  </div>
                `
                )
                .join("")}
            </article>
          </div>
        </section>

        <!-- RIGHT PANE: QUESTIONS + INSTANT GRADING + KEYWORD TABLE -->
        <aside class="right-pane" aria-label="Câu hỏi và giải thích">
          <div class="right-pane-inner">
            <div class="ielts-rubric-box">
              <div style="font-size:13.2px;line-height:1.6;color:#18181B;">
                <strong>Questions 1–${ex.questions.length}:</strong> ${ex.rubricHtml}
              </div>
              ${
                ex.nbReuse
                  ? `<div class="ielts-nb-alert">⚠️ NB You may use any letter more than once. (Chắc chắn có 1 chữ cái được chọn 2 lần!)</div>`
                  : ""
              }
            </div>

            ${
              exState.submitted
                ? `
                <div class="score-result-banner ${bannerTone}">
                  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:5px;">
                    <span style="font-size:16px;font-weight:900;color:#18181B;">
                      🎯 Kết quả: ${exState.score} / ${exState.total} câu đúng (${scorePct}%)
                    </span>
                    <span style="font-family:var(--font-mono);font-size:11.5px;font-weight:700;color:#3F3F46;">
                      Nộp lúc ${escapeHtml(formatDateTime(exState.submittedAt))}
                    </span>
                  </div>
                  <p style="font-size:13px;line-height:1.55;color:#27272A;">${escapeHtml(bandEncourage)}</p>
                </div>
              `
                : ""
            }

            ${renderQuestionSheetBody(ex, exState)}

            <div class="submit-take-bar">
              ${
                !exState.submitted
                  ? `
                  <button type="button" class="submit-take-btn" id="btn-submit-exercise">
                    <span>✓ Nộp bài &amp; Chấm điểm ngay →</span>
                  </button>
                `
                  : `
                  <button type="button" class="nb-back-btn" id="btn-retry-exercise">
                    <span>↻ Làm lại bài này</span>
                  </button>
                `
              }
              <span style="font-size:12px;color:#52525B;font-weight:600;">
                Đáp án &amp; bằng chứng mở ngay sau khi nộp
              </span>
            </div>

            <!-- Full Answer Explanations -->
            ${
              showFullExplanations
                ? `
                <section class="guide-section">
                  <div class="guide-section-header">
                    <h2 class="guide-section-title">I. Giải thích Đáp án, Bẫy &amp; Bằng chứng</h2>
                  </div>

                  <div style="display:flex;flex-direction:column;gap:9px;">
                    ${ex.questions
                      .map(q => {
                        const evalRes = exState.submitted ? evaluateQuestion(ex, q, exState.answers[q.id] || "") : null;
                        return `
                          <div class="q-explanation-box ${evalRes && !evalRes.isCorrect ? "wrong-exp" : ""}">
                            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:4px;">
                              <strong>
                                Câu ${q.num} → Đáp án chuẩn: <span style="color:#15803D;">${escapeHtml(q.displayAnswer)}</span>
                              </strong>
                              <span style="font-family:var(--font-mono);font-size:11px;font-weight:700;background:#F4F1EA;padding:2px 7px;border-radius:4px;">
                                ${escapeHtml(q.location)}
                              </span>
                            </div>
                            ${
                              evalRes && evalRes.trapWarning
                                ? `<div style="color:#B91C1C;font-weight:700;margin-bottom:4px;">${escapeHtml(evalRes.trapWarning)}</div>`
                                : ""
                            }
                            <div>${escapeHtml(q.explain)}</div>
                            <button type="button" class="evidence-jump-btn" data-jump-evidence="${escapeHtml(q.evidenceSentenceId)}">
                              📍 Xem câu bằng chứng trong bài
                            </button>
                          </div>
                        `;
                      })
                      .join("")}
                  </div>
                </section>
              `
                : ""
            }

            <!-- Keyword Table for this passage -->
            <section class="guide-section">
              <div class="guide-section-header">
                <h2 class="guide-section-title">II. Bảng Từ Khoá (Keyword Table) bài này</h2>
                <span style="font-size:11.5px;color:#71717A;">Bấm để nghe · Lưu vào kho ôn tập</span>
              </div>
              ${renderKeywordTableHtml(ex.keywordTable, ex.title)}
            </section>
          </div>
        </aside>
      </main>

      <nav class="practice-bottom-nav" aria-label="Điều hướng bài tập">
        <div class="bottom-q-pills">
          <span class="bottom-part-text">${escapeHtml(getPartMeta(ex.part).shortLabel)}</span>
          ${samePartList
            .map((item, idx) => {
              const isAct = item.id === ex.id;
              const isDone = Boolean(stu.exercises[item.id] && stu.exercises[item.id].submitted);
              return `
                <button
                  type="button"
                  class="q-pill-btn ${isAct ? "active" : ""} ${isDone ? "done" : ""}"
                  data-open-exercise="${escapeHtml(item.id)}"
                  title="Bài ${idx + 1}: ${escapeHtml(item.title)}"
                >${idx + 1}</button>
              `;
            })
            .join("")}
          <span class="bottom-q-counter">Đã làm ${doneInPart}/${samePartList.length}</span>
        </div>

        <div class="stepper-row">
          <button type="button" class="btn-prev-q" id="btn-prev-ex" ${exIdx <= 0 ? "disabled" : ""}>
            ← Bài trước
          </button>
          <button type="button" class="btn-next-q" id="btn-next-ex">
            ${exIdx < samePartList.length - 1 ? "Bài tiếp theo →" : "Về danh sách →"}
          </button>
        </div>
      </nav>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 5: MASTER KEYWORD TABLE HUB + FLASHCARD TRAINER
  // --------------------------------------------------------------------------
  function renderKeywordHubView() {
    const q = state.kwHubSearch.trim().toLowerCase();
    const filtered = MASTER_KEYWORDS.filter(item => {
      if (state.kwHubFilter !== "all" && item.group !== state.kwHubFilter) return false;
      if (!q) return true;
      return `${item.q} ${item.p} ${item.vi} ${item.source}`.toLowerCase().includes(q);
    });

    const cardItem = filtered.length > 0 ? filtered[state.kwHubCardIdx % filtered.length] : null;

    return `
      <main class="home-container">
        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">IELTS READING · PARAPHRASE &amp; SYNONYMS</div>
            <h1 class="home-h1">BẢNG TỪ KHOÁ TỔNG HỢP (KEYWORD TABLE)</h1>
            <p class="home-desc">
              Bản chất của IELTS Reading là nối <strong>Từ đồng nghĩa</strong> giữa Câu hỏi và Bài đọc. Học thuộc toàn bộ ${MASTER_KEYWORDS.length} cặp từ khoá từ ${EXERCISES.length} bài đọc dưới đây hoặc bật <strong>Chế độ Flashcard</strong> để tự kiểm tra!
            </p>
          </div>
          <button type="button" class="submit-take-btn" id="btn-toggle-kwhub-flashcard">
            ${state.kwHubFlashcardMode ? "📋 Xem dạng Bảng tổng hợp" : "🃏 Luyện Flashcard Đồng nghĩa"}
          </button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          <div class="level-switch-group">
            <button type="button" class="level-switch-btn ${state.kwHubFilter === "all" ? "active" : ""}" data-kw-filter="all">Tất cả (${MASTER_KEYWORDS.length})</button>
            <button type="button" class="level-switch-btn ${state.kwHubFilter === "gap-filling" ? "active" : ""}" data-kw-filter="gap-filling">Dạng 1: Gap-filling</button>
            <button type="button" class="level-switch-btn ${state.kwHubFilter === "matching-names" ? "active" : ""}" data-kw-filter="matching-names">Dạng 2: Matching Names</button>
            <button type="button" class="level-switch-btn ${state.kwHubFilter === "multiple-choice" ? "active" : ""}" data-kw-filter="multiple-choice">Dạng 3: Multiple Choice</button>
            <button type="button" class="level-switch-btn ${state.kwHubFilter === "matching-info" ? "active" : ""}" data-kw-filter="matching-info">Dạng 4: Matching Info</button>
          </div>

          <input
            type="text"
            id="kwhub-search-input"
            class="form-input"
            style="width:270px;height:36px;"
            placeholder="Lọc cặp từ đồng nghĩa..."
            value="${escapeHtml(state.kwHubSearch)}"
          />
        </div>

        ${
          state.kwHubFlashcardMode && cardItem
            ? `
            <div style="max-width:640px;margin:18px auto;">
              <div style="text-align:center;font-family:var(--font-mono);font-size:12px;font-weight:700;color:#71717A;margin-bottom:8px;">
                Thẻ ${(state.kwHubCardIdx % filtered.length) + 1} / ${filtered.length} · ${escapeHtml(cardItem.source)}
              </div>
              <div class="flashcard-stage" id="btn-flip-kwhub-card">
                <div style="font-size:11.5px;font-weight:800;text-transform:uppercase;color:#71717A;">Từ khoá trong Câu hỏi (Bấm vào thẻ để lật đáp án)</div>
                <div class="flashcard-front">“${escapeHtml(cardItem.q)}”</div>
                <button type="button" class="top-pill-btn" style="height:30px;font-size:12px;margin-top:6px;" data-speak-word="${escapeHtml(cardItem.q)}">🔊 Nghe phát âm</button>
                ${
                  state.kwHubCardFlipped
                    ? `
                    <div class="flashcard-back">
                      <div style="font-size:11.5px;font-weight:800;color:#15803D;text-transform:uppercase;">Từ tương đương trong Bài đọc (Passage)</div>
                      <div style="font-size:20px;font-weight:900;color:#15803D;margin:6px 0;">${escapeHtml(cardItem.p)}</div>
                      <div style="font-size:14.5px;font-weight:700;color:#18181B;">Nghĩa: ${escapeHtml(cardItem.vi)}</div>
                    </div>
                  `
                    : `<div style="margin-top:14px;font-size:12.5px;color:#71717A;">👆 Em thử đoán từ đồng nghĩa trong bài đọc rồi bấm vào thẻ để kiểm tra nhé!</div>`
                }
              </div>
              <div style="display:flex;justify-content:center;gap:10px;">
                <button type="button" class="nb-back-btn" id="btn-kwhub-prev">← Thẻ trước</button>
                <button type="button" class="submit-take-btn" style="height:36px;" id="btn-kwhub-next">Thẻ tiếp theo →</button>
              </div>
            </div>
          `
            : renderKeywordTableHtml(filtered, "Bảng Keyword Table")
        }
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // VIEW 6: MY SUBMISSIONS HISTORY (READING + WRITING)
  // --------------------------------------------------------------------------
  function renderSubmissionsView() {
    const stu = getActiveStudent();
    const submittedList = EXERCISES.filter(ex => stu.exercises[ex.id] && stu.exercises[ex.id].submitted)
      .map(ex => ({ ex, st: stu.exercises[ex.id] }))
      .sort((a, b) => new Date(b.st.submittedAt || 0).getTime() - new Date(a.st.submittedAt || 0).getTime());
    const writingEssays = getSubmittedWritingEssaysList();

    return `
      <main class="home-container">
        <div class="home-header-block">
          <div>
            <div class="home-eyebrow">READING &amp; WRITING · SUBMISSION HISTORY</div>
            <h1 class="home-h1">LỊCH SỬ BÀI LÀM &amp; TIẾN ĐỘ</h1>
            <p class="home-desc">
              Theo dõi toàn bộ kết quả bài đọc (Reading) và bài viết (Writing) đã hoàn thành.
            </p>
          </div>
          <button type="button" class="top-pill-btn yellow" id="btn-export-student-json-2">
            📤 Xuất lịch sử bài làm (.json)
          </button>
        </div>

        ${
          submittedList.length === 0 && writingEssays.length === 0
            ? `
            <div class="ej-history-empty">
              <p style="font-size:15.5px;font-weight:800;color:#18181B;margin-bottom:6px;">Chưa có bài nộp nào.</p>
              <p style="font-size:13.5px;margin-bottom:14px;">Chọn một bài Reading hoặc Writing để bắt đầu luyện tập ngay nhé!</p>
              <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;">
                <button type="button" class="submit-take-btn" data-sb-nav="reading-hub">Luyện Reading →</button>
                <button type="button" class="nb-back-btn" data-sb-nav="writing-hub">Luyện Writing →</button>
              </div>
            </div>
          `
            : `
            ${
              writingEssays.length > 0
                ? `
              <h2 class="wr-history-group-title">✍️ Bài Writing đã nộp (${writingEssays.length})</h2>
              <div class="ej-history-list" style="margin-bottom:22px;">
                ${writingEssays
                  .map(({ unit, info, cloudSub, releasedReview }) => {
                    const remain =
                      !releasedReview && cloudSub && cloudSub.ai_release_at && CLOUD
                        ? CLOUD.formatRemainingTime(cloudSub.ai_release_at)
                        : "";
                    const errCount =
                      releasedReview && releasedReview.review_json && Array.isArray(releasedReview.review_json.corrections)
                        ? releasedReview.review_json.corrections.length
                        : 0;
                    let statusTagHtml = `<span class="notif-item-tag">${info.wordCount || 0} từ</span>`;
                    if (releasedReview) {
                      statusTagHtml = `<span class="notif-item-tag">✅ Đã trả bài sửa (${errCount} lỗi)</span>`;
                    } else if (remain) {
                      statusTagHtml = `<span class="notif-item-tag" style="background:#FEF3C7;color:#92400E;">⏳ Chờ trả bài (còn ${escapeHtml(remain)})</span>`;
                    }
                    const hasTeacherFb = Boolean(cloudSub && cloudSub.teacher_feedback && cloudSub.teacher_feedback.trim());
                    return `
                  <div class="ej-history-card">
                    <div class="ej-history-left">
                      <div class="ej-history-badges">
                        <span class="class-badge-pill">Writing · Unit ${escapeHtml(unit.number)}</span>
                        ${statusTagHtml}
                        ${hasTeacherFb ? `<span class="notif-item-tag" style="background:#EEF2FF;color:#3730A3;">👨‍🏫 Có nhận xét GV</span>` : ""}
                      </div>
                      <div class="ej-history-title">${escapeHtml(unit.titleEn)} — ${escapeHtml(unit.titleVi)}</div>
                      <div class="ej-history-meta">Nộp lúc ${escapeHtml(formatDateTime(info.submittedAt))} · ${info.wordCount || 0} từ</div>
                    </div>
                    <button type="button" class="nb-back-btn" data-open-writing-unit="${escapeHtml(unit.id)}" data-open-writing-sec="writing">
                      ${releasedReview ? "Xem bài sửa chi tiết →" : "Xem lại bài viết →"}
                    </button>
                  </div>
                `;
                  })
                  .join("")}
              </div>
            `
                : ""
            }

            ${
              submittedList.length > 0
                ? `
              <h2 class="wr-history-group-title">📖 Bài Reading đã nộp (${submittedList.length})</h2>
              <div class="ej-history-list">
                ${submittedList
                  .map(({ ex, st }) => {
                    const pct = st.total ? Math.round((st.score / st.total) * 100) : 0;
                    return `
                      <div class="ej-history-card">
                        <div class="ej-history-left">
                          <div class="ej-history-badges">
                            <span class="class-badge-pill">${escapeHtml(getPartMeta(ex.part).shortLabel)} · Bài ${ex.number}</span>
                            <span class="notif-item-tag" style="${pct >= 60 ? "" : "background:#FEE2E2;color:#991B1B;"}">
                              Điểm: ${st.score}/${st.total} (${pct}%)
                            </span>
                          </div>
                          <div class="ej-history-title">${escapeHtml(ex.title)}</div>
                          <div class="ej-history-meta">Nộp lúc ${escapeHtml(formatDateTime(st.submittedAt))} · ${escapeHtml(ex.badge)}</div>
                        </div>
                        <button type="button" class="nb-back-btn" data-open-exercise="${escapeHtml(ex.id)}">
                          Xem lại &amp; Bằng chứng →
                        </button>
                      </div>
                    `;
                  })
                  .join("")}
              </div>
            `
                : ""
            }
          `
        }
      </main>
    `;
  }

  // --------------------------------------------------------------------------
  // MODALS: PERSONAL VOCAB BANK (+ FLASHCARD) & PROFILE SWITCHER
  // --------------------------------------------------------------------------
  function renderModalsHtml() {
    const stu = getActiveStudent();
    let html = "";

    if (state.vocabModalOpen) {
      const allWords = stu.savedVocab || [];
      const q = state.vocabSearchQuery.trim().toLowerCase();
      const filtered = q
        ? allWords.filter(v => `${v.word} ${v.meaning} ${v.topic}`.toLowerCase().includes(q))
        : allWords;
      const fcItem = filtered.length > 0 ? filtered[state.flashcardIndex % filtered.length] : null;

      html += `
        <div class="modal-backdrop" id="vocab-modal-backdrop">
          <div class="modal-panel" onclick="event.stopPropagation()">
            <div class="modal-header">
              <div>
                <h2 style="font-size:17px;font-weight:900;color:#18181B;">
                  📚 Kho từ vựng &amp; Keyword Table của tôi (${allWords.length} mục)
                </h2>
                <p style="font-size:12.5px;color:#52525B;margin-top:2px;">
                  Bấm vào từ để nghe phát âm hoặc chuyển sang chế độ Flashcard để ôn tập nhanh.
                </p>
              </div>
              <button type="button" class="close-modal-btn" id="btn-close-vocab-modal">✕</button>
            </div>

            <div class="modal-body">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
                <div class="level-switch-group">
                  <button type="button" class="level-switch-btn ${state.vocabModalTab === "list" ? "active" : ""}" data-vocab-tab="list">📋 Danh sách từ</button>
                  <button type="button" class="level-switch-btn ${state.vocabModalTab === "flashcard" ? "active" : ""}" data-vocab-tab="flashcard">🃏 Ôn bằng Flashcard</button>
                </div>
                <input
                  type="text"
                  id="vocab-search-input"
                  class="form-input"
                  style="height:35px;max-width:280px;"
                  placeholder="Tìm từ đã lưu..."
                  value="${escapeHtml(state.vocabSearchQuery)}"
                />
              </div>

              ${
                state.vocabModalTab === "flashcard"
                  ? fcItem
                    ? `
                    <div class="flashcard-stage" id="btn-flip-vocab-fc">
                      <div style="font-size:11px;font-weight:800;color:#71717A;text-transform:uppercase;">
                        Thẻ ${(state.flashcardIndex % filtered.length) + 1}/${filtered.length} · ${escapeHtml(fcItem.topic || "")}
                      </div>
                      <div class="flashcard-front">${escapeHtml(fcItem.word)}</div>
                      ${fcItem.ipa ? `<div style="font-family:var(--font-mono);font-size:13px;color:#71717A;">${escapeHtml(fcItem.ipa)}</div>` : ""}
                      ${
                        state.flashcardFlipped
                          ? `
                          <div class="flashcard-back">
                            <div style="font-size:18px;font-weight:900;color:#15803D;">${escapeHtml(fcItem.meaning)}</div>
                            ${fcItem.example ? `<div style="font-size:13px;color:#52525B;margin-top:6px;">${escapeHtml(fcItem.example)}</div>` : ""}
                          </div>
                        `
                          : `<div style="margin-top:12px;font-size:12.5px;color:#71717A;">👆 Bấm vào thẻ để xem nghĩa tiếng Việt</div>`
                      }
                    </div>
                    <div style="display:flex;justify-content:center;gap:10px;">
                      <button type="button" class="nb-back-btn" id="btn-fc-prev">← Trước</button>
                      <button type="button" class="top-pill-btn" data-speak-word="${escapeHtml(fcItem.word.split("↔")[0])}">🔊 Nghe</button>
                      <button type="button" class="submit-take-btn" style="height:36px;" id="btn-fc-next">Tiếp →</button>
                    </div>
                  `
                    : `<p style="color:#71717A;">Chưa có từ vựng nào để ôn Flashcard.</p>`
                  : `
                  <form id="add-custom-vocab-form" onsubmit="return false;" style="background:#FAF9F6;border:1.5px solid #E4E4E7;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
                    <div style="font-size:12px;font-weight:800;text-transform:uppercase;margin-bottom:8px;">+ Tự thêm từ vựng / cặp đồng nghĩa mới</div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">
                      <input type="text" id="custom-vocab-word" class="form-input" style="height:34px;" placeholder="Từ hoặc cặp đồng nghĩa *" required />
                      <input type="text" id="custom-vocab-ipa" class="form-input" style="height:34px;" placeholder="IPA (tùy chọn)" />
                      <input type="text" id="custom-vocab-meaning" class="form-input" style="height:34px;" placeholder="Nghĩa tiếng Việt *" required />
                    </div>
                    <div style="display:flex;gap:8px;margin-top:8px;">
                      <input type="text" id="custom-vocab-example" class="form-input" style="height:34px;flex:1;" placeholder="Ghi chú / Ví dụ (tùy chọn)..." />
                      <button type="submit" class="top-pill-btn dark" style="height:34px;">+ Lưu từ</button>
                    </div>
                  </form>

                  <div class="vocab-table-wrap">
                    <table class="vocab-table">
                      <thead>
                        <tr>
                          <th>Từ / Cặp từ (Bấm để nghe)</th>
                          <th>Nghĩa</th>
                          <th>Nguồn</th>
                          <th style="width:55px;">Xóa</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${filtered
                          .map(
                            item => `
                            <tr>
                              <td>
                                <button type="button" class="vocab-word-click-btn" data-speak-word="${escapeHtml(item.word.split("↔")[0])}">
                                  <span>🔊</span><span>${escapeHtml(item.word)}</span>
                                </button>
                                ${item.ipa ? `<span class="vocab-ipa-line">${escapeHtml(item.ipa)}</span>` : ""}
                              </td>
                              <td><strong>${escapeHtml(item.meaning)}</strong></td>
                              <td style="font-size:12px;color:#52525B;">${escapeHtml(item.topic || "")}</td>
                              <td><button type="button" class="take-delete-btn" data-remove-saved-vocab="${escapeHtml(item.word)}">Xóa</button></td>
                            </tr>
                          `
                          )
                          .join("")}
                      </tbody>
                    </table>
                  </div>
                `
              }
            </div>
          </div>
        </div>
      `;
    }

    return html;
  }

  function renderAuthScreen() {
    const isReg = state.authMode === "register";
    return `
      <div class="auth-wrapper">
        <div class="auth-card-box">
          <div style="margin-bottom:10px;">
            <span class="auth-badge-tag">IELTS READING &amp; WRITING · ĐĂNG NHẬP</span>
          </div>

          <h1 style="font-size:22px;font-weight:900;color:#18181B;margin-bottom:6px;">
            ${isReg ? "Tạo tài khoản mới" : "Đăng nhập luyện Reading &amp; Writing"}
          </h1>
          <p style="font-size:13.2px;color:#52525B;line-height:1.5;margin-bottom:16px;">
            ${isReg
              ? "Tài khoản này dùng chung cho cả hệ thống IELTS Reading, Writing và IELTS Listening."
              : "Sử dụng tài khoản Google hoặc Email đã đăng ký ở <strong>IELTS Listening</strong> để đăng nhập ngay."}
          </p>

          <button type="button" class="google-auth-btn" id="btn-google-login" ${state.authLoading ? "disabled" : ""}>
            ${CLOUD ? CLOUD.renderGoogleIconSvg(19) : ""}
            <span>${state.authLoading ? "Đang kết nối tới Google..." : "Tiếp tục với Google"}</span>
          </button>

          <div class="auth-or-divider"><span>Hoặc dùng tài khoản Email</span></div>

          <div class="auth-tabs-row">
            <button type="button" class="auth-tab ${!isReg ? "active" : ""}" id="btn-tab-login">Đăng nhập</button>
            <button type="button" class="auth-tab ${isReg ? "active" : ""}" id="btn-tab-register">Tạo tài khoản mới</button>
          </div>

          ${state.authError ? `<div class="auth-msg-err">⚠️ ${escapeHtml(state.authError)}</div>` : ""}
          ${state.authInfo ? `<div class="auth-msg-ok">✓ ${escapeHtml(state.authInfo)}</div>` : ""}

          <form id="auth-form" onsubmit="return false;">
            ${isReg ? `
              <div class="form-field">
                <label class="form-label" for="inp-auth-name">Họ và tên</label>
                <input type="text" id="inp-auth-name" class="form-input" placeholder="Ví dụ: Nguyễn Minh Tùng" required />
              </div>
            ` : ""}

            <div class="form-field">
              <label class="form-label" for="inp-auth-email">Email</label>
              <input type="email" id="inp-auth-email" class="form-input" placeholder="Nhập email của bạn..." required />
            </div>

            <div class="form-field">
              <label class="form-label" for="inp-auth-pass">Mật khẩu</label>
              <input type="password" id="inp-auth-pass" class="form-input" placeholder="Nhập mật khẩu..." required />
            </div>

            <button type="submit" class="form-submit-btn" ${state.authLoading ? "disabled" : ""}>
              ${isReg ? "Tạo tài khoản &amp; Vào học →" : "Đăng nhập →"}
            </button>
          </form>
        </div>
      </div>
    `;
  }

  // --------------------------------------------------------------------------
  // MAIN RENDER
  // --------------------------------------------------------------------------
  function renderApp(resetScrollPanes, scrollToWrPart) {
    const root = document.getElementById("app");
    if (!root) return;

    if (!currentAccount) {
      root.innerHTML = renderAuthScreen();
      bindEvents();
      return;
    }

    const leftPane = document.querySelector(".left-pane");
    const rightPane = document.querySelector(".right-pane");
    const sbNav = document.querySelector(".ej-sidebar-nav");
    const savedL = !resetScrollPanes && leftPane ? leftPane.scrollTop : 0;
    const savedR = !resetScrollPanes && rightPane ? rightPane.scrollTop : 0;
    const savedS = sbNav ? sbNav.scrollTop : 0;

    const isPractice = state.view === "practice";
    const isWritingLesson = state.view === "writing-lesson";
    const isFocusLesson = isPractice || isWritingLesson;
    const layoutClasses = [
      "app-layout",
      state.sidebarCollapsed ? "sidebar-collapsed" : "",
      state.mobileSidebarOpen ? "mobile-sidebar-open" : "",
      isFocusLesson ? "focus-lesson-mode split-tab-active" : ""
    ]
      .filter(Boolean)
      .join(" ");

    let bodyHtml = "";
    if (isPractice) bodyHtml = renderPracticeView();
    else if (isWritingLesson) bodyHtml = renderWritingLessonView();
    else if (state.view === "reading-hub") bodyHtml = renderReadingHubView();
    else if (state.view === "writing-hub") bodyHtml = renderWritingHubView();
    else if (state.view === "theory") bodyHtml = renderTheoryView();
    else if (state.view === "part-topics") bodyHtml = renderPartTopicsView();
    else if (state.view === "keyword-hub") bodyHtml = renderKeywordHubView();
    else if (state.view === "my-submissions") bodyHtml = renderSubmissionsView();
    else bodyHtml = renderHomeView();

    root.innerHTML = `
      <div class="${layoutClasses}" id="main-app-layout">
        ${renderSidebarHtml()}
        <div class="ej-main-shell">
          ${renderTopbarHtml()}
          ${bodyHtml}
        </div>
      </div>
      ${renderModalsHtml()}
    `;

    const nextL = document.querySelector(".left-pane");
    const nextR = document.querySelector(".right-pane");
    const nextS = document.querySelector(".ej-sidebar-nav");
    if (scrollToWrPart && nextL) {
      const targetPartEl = document.getElementById("wr-theory-part-" + scrollToWrPart);
      if (targetPartEl) targetPartEl.scrollIntoView({ behavior: "smooth", block: "start" });
      if (nextR) nextR.scrollTop = 0;
    } else {
      if (nextL) nextL.scrollTop = savedL;
      if (nextR) nextR.scrollTop = savedR;
    }
    if (nextS) nextS.scrollTop = savedS;

    bindEvents();
  }

  function openWritingUnit(unitId, sectionKey) {
    stopSpeech();
    const target = WRITING_UNITS.find(u => u.id === unitId) || WRITING_UNITS[0];
    if (!target) return;
    state.currentWritingUnitId = target.id;
    state.currentWritingSection = sectionKey && target.sections[sectionKey] ? sectionKey : "vocabulary";
    const secObj = target.sections[state.currentWritingSection];
    const partKeys = secObj && secObj.parts ? Object.keys(secObj.parts) : ["A"];
    state.currentWritingPart = partKeys[0] || "A";
    state.activeReorderKey = "";
    state.mobileSidebarOpen = false;
    state.notifOpen = false;
    state.accountMenuOpen = false;
    state.view = "writing-lesson";
    syncSidebarSkillAccordion(state.view);
    renderApp(true);
  }

  function advanceWritingStep() {
    const unit = getCurrentWritingUnit();
    if (!unit) return;
    const order = ["vocabulary", "phrases", "writing"];
    const secObj = unit.sections[state.currentWritingSection];
    const partKeys = secObj && secObj.parts ? Object.keys(secObj.parts) : [];
    const curPartIdx = partKeys.indexOf(state.currentWritingPart);

    if (curPartIdx >= 0 && curPartIdx < partKeys.length - 1 && !(secObj && secObj.allExercisesInOneList)) {
      const nextPart = partKeys[curPartIdx + 1];
      state.currentWritingPart = nextPart;
      renderApp(false, nextPart);
      return;
    }

    const secIdx = order.indexOf(state.currentWritingSection);
    if (secIdx >= 0 && secIdx < order.length - 1) {
      state.currentWritingSection = order[secIdx + 1];
      const nextSec = unit.sections[state.currentWritingSection];
      state.currentWritingPart = nextSec && nextSec.parts ? Object.keys(nextSec.parts)[0] || "A" : "A";
      renderApp(true);
      return;
    }

    // Last section of unit -> go to next unit or back to writing hub
    const uIdx = WRITING_UNITS.findIndex(u => u.id === unit.id);
    if (uIdx >= 0 && uIdx < WRITING_UNITS.length - 1) {
      openWritingUnit(WRITING_UNITS[uIdx + 1].id, "vocabulary");
    } else {
      stopSpeech();
      state.view = "writing-hub";
      renderApp(true);
    }
  }

  function previousWritingStep() {
    const unit = getCurrentWritingUnit();
    if (!unit) return;
    const order = ["vocabulary", "phrases", "writing"];
    const secObj = unit.sections[state.currentWritingSection];
    const partKeys = secObj && secObj.parts ? Object.keys(secObj.parts) : [];
    const curPartIdx = partKeys.indexOf(state.currentWritingPart);

    if (curPartIdx > 0 && !(secObj && secObj.allExercisesInOneList)) {
      const prevPart = partKeys[curPartIdx - 1];
      state.currentWritingPart = prevPart;
      renderApp(false, prevPart);
      return;
    }

    const secIdx = order.indexOf(state.currentWritingSection);
    if (secIdx > 0) {
      state.currentWritingSection = order[secIdx - 1];
      const prevSec = unit.sections[state.currentWritingSection];
      const prevKeys = prevSec && prevSec.parts ? Object.keys(prevSec.parts) : ["A"];
      state.currentWritingPart = prevKeys[prevKeys.length - 1] || "A";
      renderApp(true);
    }
  }

  function openExercise(exId) {
    stopSpeech();
    const target = EXERCISES.find(e => e.id === exId);
    if (!target) return;
    if (state.view !== "practice") {
      state.prevDashboardView = state.view;
    }
    state.selectedPart = target.part;
    state.currentExerciseId = target.id;
    state.activeEvidenceSentenceId = "";
    state.activeFocusedGapId = target.questions[0] ? target.questions[0].id : "";
    state.mobileSidebarOpen = false;
    state.notifOpen = false;
    state.accountMenuOpen = false;
    state.view = "practice";
    syncSidebarSkillAccordion(state.view);
    renderApp();
    const lp = document.querySelector(".left-pane");
    const rp = document.querySelector(".right-pane");
    if (lp) lp.scrollTop = 0;
    if (rp) rp.scrollTop = 0;
  }

  function exportStudentJson() {
    const stu = getActiveStudent();
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "IELTS Reading Tinh Gọn",
      student: stu
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ielts-reading-${stu.name.toLowerCase().replace(/\s+/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --------------------------------------------------------------------------
  // EVENT BINDING
  // --------------------------------------------------------------------------
  function bindEvents() {
    const stu = getActiveStudent();

    // Auth screen handlers (shared Supabase Auth with IELTS Listening)
    const btnTabLogin = document.getElementById("btn-tab-login");
    if (btnTabLogin) {
      btnTabLogin.onclick = () => {
        state.authMode = "login";
        state.authError = "";
        renderApp();
      };
    }

    const btnTabReg = document.getElementById("btn-tab-register");
    if (btnTabReg) {
      btnTabReg.onclick = () => {
        state.authMode = "register";
        state.authError = "";
        renderApp();
      };
    }

    const btnGoogleLogin = document.getElementById("btn-google-login");
    if (btnGoogleLogin) {
      btnGoogleLogin.onclick = async () => {
        if (!CLOUD) {
          state.authError = "Chưa tải được cấu hình Supabase.";
          renderApp();
          return;
        }
        state.authError = "";
        state.authInfo = "";
        state.authLoading = true;
        renderApp();
        const { error } = await CLOUD.signInWithGoogle();
        if (error) {
          state.authLoading = false;
          state.authError = "Không thể mở đăng nhập Google: " + (error.message || "Lỗi kết nối");
          renderApp();
        }
      };
    }

    const authForm = document.getElementById("auth-form");
    if (authForm) {
      authForm.onsubmit = async e => {
        e.preventDefault();
        const client = CLOUD ? CLOUD.getClient() : null;
        if (!client) {
          state.authError = "Chưa cấu hình kết nối Supabase.";
          renderApp();
          return;
        }
        const nameEl = document.getElementById("inp-auth-name");
        const email = (document.getElementById("inp-auth-email").value || "").trim().toLowerCase();
        const password = (document.getElementById("inp-auth-pass").value || "").trim();
        const name = (nameEl ? nameEl.value : "").trim();

        if (!email || !password) {
          state.authError = "Vui lòng nhập đầy đủ Email và Mật khẩu.";
          renderApp();
          return;
        }

        state.authLoading = true;
        state.authError = "";
        state.authInfo = "";
        renderApp();

        if (state.authMode === "register") {
          if (!name) {
            state.authLoading = false;
            state.authError = "Vui lòng nhập tên của bạn.";
            renderApp();
            return;
          }
          if (password.length < 6) {
            state.authLoading = false;
            state.authError = "Mật khẩu cần tối thiểu 6 ký tự.";
            renderApp();
            return;
          }
          const { data, error } = await client.auth.signUp({
            email,
            password,
            options: {
              data: { full_name: name },
              emailRedirectTo: CLOUD.getRedirectUrl()
            }
          });
          state.authLoading = false;
          if (error) {
            state.authError = error.message || "Không thể tạo tài khoản.";
            renderApp();
            return;
          }
          if (data && data.session && data.user) {
            await loadCloudAccount(data.user);
          } else {
            state.authInfo = "Đăng ký thành công! Vui lòng kiểm tra Email để xác nhận, hoặc dùng 'Tiếp tục với Google'.";
            state.authMode = "login";
            renderApp();
          }
        } else {
          const { data, error } = await client.auth.signInWithPassword({ email, password });
          state.authLoading = false;
          if (error) {
            state.authError = "Email hoặc mật khẩu chưa đúng (hoặc tài khoản chưa xác nhận email).";
            renderApp();
            return;
          }
          if (data && data.user) {
            await loadCloudAccount(data.user);
          }
        }
      };
    }

    // Navigation buttons
    document.querySelectorAll("[data-sb-nav]").forEach(btn => {
      btn.onclick = () => {
        stopSpeech();
        const target = btn.getAttribute("data-sb-nav");
        state.view = target || "home";
        state.prevDashboardView = state.view;
        syncSidebarSkillAccordion(state.view);
        state.mobileSidebarOpen = false;
        state.notifOpen = false;
        state.accountMenuOpen = false;
        renderApp();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
    });

    document.querySelectorAll("[data-open-part]").forEach(btn => {
      btn.onclick = () => {
        stopSpeech();
        state.selectedPart = btn.getAttribute("data-open-part") || "gap-filling";
        state.view = "part-topics";
        state.prevDashboardView = "part-topics";
        syncSidebarSkillAccordion(state.view);
        state.mobileSidebarOpen = false;
        state.notifOpen = false;
        state.accountMenuOpen = false;
        renderApp();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
    });

    document.querySelectorAll("[data-open-exercise]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const notifId = btn.getAttribute("data-notif-id");
        if (notifId) {
          const found = stu.notifications.find(n => n.id === notifId);
          if (found) {
            found.read = true;
            persist();
          }
        }
        openExercise(btn.getAttribute("data-open-exercise"));
      };
    });

    document.querySelectorAll("[data-open-writing-unit]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const notifId = btn.getAttribute("data-notif-id");
        if (notifId) {
          const found = stu.notifications.find(n => n.id === notifId);
          if (found) {
            found.read = true;
            persist();
          }
        }
        const unitId = btn.getAttribute("data-open-writing-unit");
        const secKey = btn.getAttribute("data-open-writing-sec") || "vocabulary";
        if (btn.getAttribute("data-mark-review-seen") || secKey === "writing") {
          markWritingReviewSeen(unitId);
        }
        openWritingUnit(unitId, secKey);
      };
    });

    // Sidebar controls
    const btnSbCollapse = document.getElementById("ej-sidebar-collapse-btn");
    if (btnSbCollapse) {
      btnSbCollapse.onclick = () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        try {
          localStorage.setItem("ielts_reading_sb_collapsed", state.sidebarCollapsed ? "1" : "0");
        } catch (e) {}
        renderApp();
      };
    }

    const btnReadingAcc = document.getElementById("btn-sb-reading-acc");
    if (btnReadingAcc) {
      btnReadingAcc.onclick = e => {
        e.stopPropagation();
        state.sbReadingCollapsed = !state.sbReadingCollapsed;
        if (!state.sbReadingCollapsed) state.sbWritingCollapsed = true;
        renderApp();
      };
    }

    const btnWritingAcc = document.getElementById("btn-sb-writing-acc");
    if (btnWritingAcc) {
      btnWritingAcc.onclick = e => {
        e.stopPropagation();
        state.sbWritingCollapsed = !state.sbWritingCollapsed;
        if (!state.sbWritingCollapsed) state.sbReadingCollapsed = true;
        renderApp();
      };
    }

    const btnMobMenu = document.getElementById("ej-mobile-menu-btn");
    if (btnMobMenu) {
      btnMobMenu.onclick = () => {
        state.mobileSidebarOpen = !state.mobileSidebarOpen;
        renderApp();
      };
    }

    const sbBack = document.getElementById("ej-sidebar-backdrop");
    if (sbBack) {
      sbBack.onclick = () => {
        state.mobileSidebarOpen = false;
        renderApp();
      };
    }

    // Topbar menus
    const btnNotif = document.getElementById("topbar-notif-btn");
    if (btnNotif) {
      btnNotif.onclick = e => {
        e.stopPropagation();
        state.notifOpen = !state.notifOpen;
        state.accountMenuOpen = false;
        if (state.notifOpen) {
          stu.notifications.forEach(n => { n.read = true; });
          persist();
          refreshCloudWritingReviews(true);
        }
        renderApp();
      };
    }

    const btnAccMenu = document.getElementById("btn-toggle-account-menu");
    if (btnAccMenu) {
      btnAccMenu.onclick = e => {
        e.stopPropagation();
        state.accountMenuOpen = !state.accountMenuOpen;
        state.notifOpen = false;
        renderApp();
      };
    }

    const btnOpenVocab = document.getElementById("btn-open-vocab-bank");
    if (btnOpenVocab) {
      btnOpenVocab.onclick = () => {
        state.vocabModalOpen = true;
        state.accountMenuOpen = false;
        renderApp();
      };
    }

    const btnLogout = document.getElementById("btn-logout-account");
    if (btnLogout) {
      btnLogout.onclick = async () => {
        stopSpeech();
        state.accountMenuOpen = false;
        state.notifOpen = false;
        const client = CLOUD ? CLOUD.getClient() : null;
        if (client && !state.localPreviewMode) {
          try {
            await client.auth.signOut();
          } catch (e) {}
        }
        currentAccount = null;
        cloudState.isTeacher = false;
        cloudState.submissionsByLessonId = {};
        cloudState.reviewsByLessonId = {};
        cloudState.submittingUnitId = "";
        cloudState.submitErrorByUnitId = {};
        if (cloudState.notifPollTimer) {
          clearInterval(cloudState.notifPollTimer);
          cloudState.notifPollTimer = null;
        }
        state.localPreviewMode = false;
        state.authMode = "login";
        state.authError = "";
        state.authInfo = "";
        state.authLoading = false;
        state.view = "home";
        renderApp();
      };
    }

    const btnExport2 = document.getElementById("btn-export-student-json-2");
    if (btnExport2) btnExport2.onclick = () => { exportStudentJson(); };

    // Theory Quiz
    document.querySelectorAll("[data-tq-id]").forEach(btn => {
      btn.onclick = () => {
        if (stu.theoryQuiz.submitted) return;
        const qId = btn.getAttribute("data-tq-id");
        const optIdx = parseInt(btn.getAttribute("data-tq-opt"), 10);
        stu.theoryQuiz.answers[qId] = optIdx;
        persist();
        renderApp();
      };
    });

    const btnSubmitTq = document.getElementById("btn-submit-theory-quiz");
    if (btnSubmitTq) {
      btnSubmitTq.onclick = () => {
        let score = 0;
        THEORY.quickQuiz.forEach(q => {
          if (stu.theoryQuiz.answers[q.id] === q.correctIndex) score++;
        });
        stu.theoryQuiz.submitted = true;
        stu.theoryQuiz.score = score;
        persist();
        renderApp();
      };
    }

    const btnResetTq = document.getElementById("btn-reset-theory-quiz");
    if (btnResetTq) {
      btnResetTq.onclick = () => {
        stu.theoryQuiz = { answers: {}, submitted: false, score: 0 };
        persist();
        renderApp();
      };
    }

    // Strategy Banner Worked Example Toggle
    const btnToggleWk = document.getElementById("btn-toggle-worked-ans");
    if (btnToggleWk) {
      btnToggleWk.onclick = () => {
        state.workedExampleShowAnswers = !state.workedExampleShowAnswers;
        renderApp();
      };
    }

    // Practice Room Controls
    const btnBackDash = document.getElementById("btn-back-dashboard");
    if (btnBackDash) {
      btnBackDash.onclick = () => {
        stopSpeech();
        state.view = state.prevDashboardView === "my-submissions" ? "my-submissions" : "part-topics";
        syncSidebarSkillAccordion(state.view);
        renderApp();
      };
    }

    if (state.view === "practice") {
      const ex = getCurrentExercise();
      const exState = ensureExerciseState(ex.id);
      const samePartList = getExercisesByPart(ex.part);
      const exIdx = samePartList.findIndex(item => item.id === ex.id);

      const btnHl = document.getElementById("btn-toggle-hl-tool");
      if (btnHl) {
        btnHl.onclick = () => {
          state.highlightToolActive = !state.highlightToolActive;
          if (state.highlightToolActive) state.translateModeActive = false;
          renderApp();
        };
      }

      document.querySelectorAll("[data-hl-color]").forEach(btn => {
        btn.onclick = () => {
          state.highlightColor = btn.getAttribute("data-hl-color") || "yellow";
          renderApp();
        };
      });

      const btnClearHl = document.getElementById("btn-clear-highlights");
      if (btnClearHl) {
        btnClearHl.onclick = () => {
          exState.highlightedSentences = {};
          exState.textHighlights = {};
          persist();
          renderApp();
        };
      }

      const btnScan = document.getElementById("btn-toggle-scan");
      if (btnScan) {
        btnScan.onclick = () => {
          state.scanHelperActive = !state.scanHelperActive;
          renderApp();
        };
      }

      const btnTrans = document.getElementById("btn-toggle-translate");
      if (btnTrans) {
        btnTrans.onclick = () => {
          state.translateModeActive = !state.translateModeActive;
          if (state.translateModeActive) state.highlightToolActive = false;
          renderApp();
        };
      }

      // Drag-select any text in the passage to highlight arbitrary words/phrases
      let justAppliedDragHl = false;
      const passageCard = document.getElementById("passage-paper-card");
      if (passageCard && state.highlightToolActive) {
        passageCard.onmouseup = () => {
          const sel = window.getSelection ? window.getSelection() : null;
          if (!sel || sel.isCollapsed || !sel.rangeCount) return;
          const selectedText = sel.toString();
          if (!selectedText || !selectedText.trim()) return;

          const range = sel.getRangeAt(0);
          let applied = false;
          passageCard.querySelectorAll("[data-sentence-id]").forEach(sentEl => {
            if (!range.intersectsNode(sentEl)) return;
            const sId = sentEl.getAttribute("data-sentence-id");
            const walker = document.createTreeWalker(sentEl, NodeFilter.SHOW_TEXT);
            let offset = 0;
            let hlStart = null;
            let hlEnd = null;
            let node;
            while ((node = walker.nextNode())) {
              const nodeLen = node.nodeValue ? node.nodeValue.length : 0;
              if (nodeLen > 0) {
                const nodeRange = document.createRange();
                nodeRange.selectNodeContents(node);
                const endsBefore = range.compareBoundaryPoints(Range.END_TO_START, nodeRange) >= 0;
                const startsAfter = range.compareBoundaryPoints(Range.START_TO_END, nodeRange) <= 0;
                if (!endsBefore && !startsAfter) {
                  const localStart = range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0 ? 0 : range.startOffset;
                  const localEnd = range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0 ? nodeLen : range.endOffset;
                  if (localEnd > localStart) {
                    if (hlStart === null) hlStart = offset + localStart;
                    hlEnd = offset + localEnd;
                  }
                }
              }
              offset += nodeLen;
            }
            if (hlStart !== null && hlEnd !== null && hlEnd > hlStart) {
              applyTextHighlight(exState, sId, hlStart, hlEnd, state.highlightColor);
              applied = true;
            }
          });

          if (applied) {
            justAppliedDragHl = true;
            try { sel.removeAllRanges(); } catch (e) {}
            persist();
            renderApp();
            setTimeout(() => { justAppliedDragHl = false; }, 0);
          }
        };
      }

      // Click sentences (whole sentence) or existing partial mark for highlight, or translate
      document.querySelectorAll("[data-sentence-id]").forEach(el => {
        el.onclick = e => {
          if (justAppliedDragHl) return;
          const sel = window.getSelection ? window.getSelection() : null;
          if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

          const sId = el.getAttribute("data-sentence-id");
          if (state.highlightToolActive) {
            const markEl = e.target.closest ? e.target.closest("[data-hl-sent]") : null;
            if (markEl) {
              const msId = markEl.getAttribute("data-hl-sent");
              const mStart = parseInt(markEl.getAttribute("data-hl-start"), 10);
              const mEnd = parseInt(markEl.getAttribute("data-hl-end"), 10);
              removeOrRecolorTextHighlight(exState, msId, mStart, mEnd, state.highlightColor);
              persist();
              renderApp();
              return;
            }
            if (!exState.highlightedSentences) exState.highlightedSentences = {};
            const currentColor = normalizeHighlightColor(exState.highlightedSentences[sId]);
            if (currentColor === state.highlightColor) {
              delete exState.highlightedSentences[sId];
            } else {
              exState.highlightedSentences[sId] = state.highlightColor;
            }
            persist();
            renderApp();
          } else if (state.translateModeActive) {
            state.revealedTranslations[sId] = !state.revealedTranslations[sId];
            renderApp();
          }
        };
      });

      // Gap inputs
      document.querySelectorAll("[data-gap-input]").forEach(inp => {
        inp.onfocus = () => {
          state.activeFocusedGapId = inp.getAttribute("data-gap-input");
        };
        inp.oninput = e => {
          const qId = inp.getAttribute("data-gap-input");
          exState.answers[qId] = e.target.value;
          persist();
          // Live update word-limit warning without losing cursor focus
          const val = e.target.value;
          let isWarn = false;
          if (ex.letterMode && val.trim() && !/^[A-Ha-h]$/.test(val.trim())) isWarn = true;
          if (!ex.letterMode && ex.maxWords && countWords(val) > ex.maxWords) isWarn = true;
          inp.classList.toggle("limit-warn", isWarn);
        };
      });

      // Word Box quick pick
      document.querySelectorAll("[data-pick-wordbox]").forEach(btn => {
        btn.onclick = () => {
          if (exState.submitted) return;
          const letter = btn.getAttribute("data-pick-wordbox");
          let targetQId = state.activeFocusedGapId;
          if (!targetQId || !ex.questions.some(q => q.id === targetQId)) {
            const firstEmpty = ex.questions.find(q => !(exState.answers[q.id] || "").trim());
            targetQId = (firstEmpty || ex.questions[0]).id;
          }
          exState.answers[targetQId] = letter;
          // Auto-advance focus to next empty gap
          const nextEmpty = ex.questions.find(q => !(exState.answers[q.id] || "").trim());
          state.activeFocusedGapId = nextEmpty ? nextEmpty.id : targetQId;
          persist();
          renderApp();
        };
      });

      // Matching Name / Matching Info Letter buttons
      document.querySelectorAll("[data-match-qid]").forEach(btn => {
        btn.onclick = () => {
          if (exState.submitted) return;
          const qId = btn.getAttribute("data-match-qid");
          const letter = btn.getAttribute("data-match-letter");
          exState.answers[qId] = letter;
          persist();
          renderApp();
        };
      });

      // Multiple Choice (Single & Multi-select) buttons
      document.querySelectorAll("[data-mcq-qid]").forEach(btn => {
        btn.onclick = () => {
          if (exState.submitted) return;
          const qId = btn.getAttribute("data-mcq-qid");
          const letter = btn.getAttribute("data-mcq-letter");
          const maxSel = parseInt(btn.getAttribute("data-mcq-max") || "1", 10);
          if (maxSel > 1) {
            const current = String(exState.answers[qId] || "")
              .split(",")
              .map(s => s.trim().toUpperCase())
              .filter(Boolean);
            const idx = current.indexOf(letter);
            if (idx >= 0) {
              current.splice(idx, 1);
            } else {
              if (current.length >= maxSel) {
                current.shift();
              }
              current.push(letter);
            }
            exState.answers[qId] = current.sort().join(",");
          } else {
            exState.answers[qId] = letter;
          }
          persist();
          renderApp();
        };
      });

      const btnSubmitEx = document.getElementById("btn-submit-exercise");
      if (btnSubmitEx) btnSubmitEx.onclick = () => gradeCurrentExercise();

      const btnRetryEx = document.getElementById("btn-retry-exercise");
      if (btnRetryEx) {
        btnRetryEx.onclick = () => {
          exState.answers = {};
          exState.submitted = false;
          exState.score = 0;
          state.activeEvidenceSentenceId = "";
          persist();
          renderApp();
        };
      }

      // Evidence Jump Button
      document.querySelectorAll("[data-jump-evidence]").forEach(btn => {
        btn.onclick = () => {
          const sId = btn.getAttribute("data-jump-evidence");
          state.activeEvidenceSentenceId = sId;
          renderApp();
          setTimeout(() => {
            const targetEl = document.getElementById("sent-" + sId);
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }, 40);
        };
      });

      const btnPrevEx = document.getElementById("btn-prev-ex");
      if (btnPrevEx) {
        btnPrevEx.onclick = () => {
          if (exIdx > 0) openExercise(samePartList[exIdx - 1].id);
        };
      }

      const btnNextEx = document.getElementById("btn-next-ex");
      if (btnNextEx) {
        btnNextEx.onclick = () => {
          if (exIdx < samePartList.length - 1) {
            openExercise(samePartList[exIdx + 1].id);
          } else {
            stopSpeech();
            state.view = "part-topics";
            syncSidebarSkillAccordion(state.view);
            renderApp();
          }
        };
      }
    }

    // Writing Lesson Controls
    if (state.view === "writing-lesson") {
      const unit = getCurrentWritingUnit();
      const prog = unit ? ensureWritingUnitProgress(unit.id) : null;

      const btnBackWr = document.getElementById("btn-back-writing-hub");
      if (btnBackWr) {
        btnBackWr.onclick = () => {
          stopSpeech();
          state.view = "writing-hub";
          syncSidebarSkillAccordion(state.view);
          renderApp(true);
        };
      }

      document.querySelectorAll("[data-wr-section]").forEach(btn => {
        btn.onclick = () => {
          stopSpeech();
          const nextSec = btn.getAttribute("data-wr-section") || "vocabulary";
          state.currentWritingSection = nextSec;
          const secObj = unit && unit.sections[nextSec];
          state.currentWritingPart = secObj && secObj.parts ? Object.keys(secObj.parts)[0] || "A" : "A";
          state.activeReorderKey = "";
          renderApp(true);
        };
      });

      document.querySelectorAll("[data-wr-part]").forEach(btn => {
        btn.onclick = () => {
          const targetPart = btn.getAttribute("data-wr-part") || "A";
          state.currentWritingPart = targetPart;
          renderApp(false, targetPart);
        };
      });

      document.querySelectorAll("[data-wr-jump-theory]").forEach(btn => {
        btn.onclick = () => {
          const tag = btn.getAttribute("data-wr-jump-theory") || "";
          const partLetter = tag.replace(/Part/i, "").trim() || state.currentWritingPart;
          const secEl = document.getElementById("wr-theory-part-" + partLetter) || document.querySelector(".wr-theory-part");
          if (secEl) {
            secEl.scrollIntoView({ behavior: "smooth", block: "start" });
            secEl.classList.remove("wr-flash-hl");
            void secEl.offsetWidth;
            secEl.classList.add("wr-flash-hl");
          }
        };
      });

      // 1. Matching Dropdowns
      document.querySelectorAll("[data-wr-select]").forEach(sel => {
        sel.onchange = e => {
          if (!prog) return;
          const ansKey = sel.getAttribute("data-wr-select");
          const parentEx = sel.getAttribute("data-wr-parent");
          prog.exerciseAnswers[ansKey] = e.target.value;
          if (parentEx && prog.checkedExercises[parentEx]) delete prog.checkedExercises[parentEx];
          persist();
          renderApp();
        };
      });

      // 2. MCQ & True/False Buttons
      document.querySelectorAll("[data-wr-mcq-key]").forEach(btn => {
        btn.onclick = () => {
          if (!prog) return;
          const ansKey = btn.getAttribute("data-wr-mcq-key");
          const val = btn.getAttribute("data-wr-mcq-val");
          const parentEx = btn.getAttribute("data-wr-parent");
          prog.exerciseAnswers[ansKey] = val;
          if (parentEx && prog.checkedExercises[parentEx]) delete prog.checkedExercises[parentEx];
          persist();
          renderApp();
        };
      });

      // 3. Fill & Rewrite Inputs (live DOM update without losing focus)
      document.querySelectorAll("[data-wr-fill-key]").forEach(inp => {
        inp.oninput = e => {
          if (!prog) return;
          const ansKey = inp.getAttribute("data-wr-fill-key");
          const parentEx = inp.getAttribute("data-wr-parent");
          prog.exerciseAnswers[ansKey] = e.target.value;
          if (parentEx && prog.checkedExercises[parentEx]) {
            delete prog.checkedExercises[parentEx];
            inp.classList.remove("correct", "wrong");
          }
          persist();

          const badgeEl = document.getElementById("wr-badge-" + domSafeId(ansKey));
          if (badgeEl) badgeEl.classList.toggle("filled", e.target.value.trim() !== "");

          const card = inp.closest(".wr-ex-card");
          if (card && parentEx) {
            const total = parseInt(card.getAttribute("data-wr-total") || "0", 10);
            let count = 0;
            card.querySelectorAll("[data-wr-fill-key]").forEach(el => {
              if (el.value.trim() !== "") count++;
            });
            const statusEl = document.getElementById("wr-status-" + domSafeId(parentEx));
            if (statusEl) statusEl.textContent = `Đã làm ${count}/${total}`;
            const checkBtn = document.getElementById("wr-check-" + domSafeId(parentEx));
            if (checkBtn) checkBtn.classList.toggle("unanswered", count === 0);
          }
        };

        inp.onkeydown = e => {
          if (e.key === "Enter" && prog) {
            const parentEx = inp.getAttribute("data-wr-parent");
            if (parentEx) {
              prog.checkedExercises[parentEx] = true;
              if (!prog.completedSections.includes(state.currentWritingSection)) {
                prog.completedSections.push(state.currentWritingSection);
              }
              persist();
              renderApp();
            }
          }
        };
      });

      // 4. Writing Essay Textarea (live word count without losing focus)
      document.querySelectorAll("[data-wr-writing-key]").forEach(ta => {
        ta.oninput = e => {
          if (!prog) return;
          const ansKey = ta.getAttribute("data-wr-writing-key");
          const parentEx = ta.getAttribute("data-wr-parent");
          const minW = parseInt(ta.getAttribute("data-wr-min-words") || "40", 10);
          prog.exerciseAnswers[ansKey] = e.target.value;
          if (parentEx && prog.checkedExercises[parentEx]) delete prog.checkedExercises[parentEx];
          persist();

          const wc = countWords(e.target.value);
          const needed = Math.max(0, minW - wc);
          const safeId = domSafeId(parentEx);
          const wcEl = document.getElementById("wr-wc-" + safeId);
          if (wcEl) wcEl.textContent = `${wc} từ`;
          const statusEl = document.getElementById("wr-status-" + safeId);
          if (statusEl) {
            statusEl.textContent =
              wc >= minW ? `${wc}/${minW} từ · Đủ điều kiện nộp bài` : `${wc}/${minW} từ · cần thêm ${needed} từ để nộp`;
            statusEl.classList.toggle("ready", wc >= minW);
          }
          const checkBtn = document.getElementById("wr-check-" + safeId);
          if (checkBtn) {
            checkBtn.classList.toggle("unanswered", wc < minW);
            checkBtn.disabled = wc < minW;
          }
        };
      });

      // 5. Reorder Tiles
      document.querySelectorAll("[data-wr-reorder-row]").forEach(rowEl => {
        rowEl.onclick = e => {
          if (e.target.closest("[data-wr-add-tile]") || e.target.closest("[data-wr-remove-tile]")) return;
          const rKey = rowEl.getAttribute("data-wr-reorder-row");
          if (state.activeReorderKey !== rKey) {
            state.activeReorderKey = rKey;
            renderApp();
          }
        };
      });

      document.querySelectorAll("[data-wr-add-tile]").forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          if (!prog) return;
          const ansKey = btn.getAttribute("data-wr-add-tile");
          const idx = parseInt(btn.getAttribute("data-wr-tile-idx"), 10);
          const parentEx = btn.getAttribute("data-wr-parent");
          state.activeReorderKey = ansKey;
          if (parentEx && prog.checkedExercises[parentEx]) delete prog.checkedExercises[parentEx];
          if (!Array.isArray(prog.exerciseAnswers[ansKey])) prog.exerciseAnswers[ansKey] = [];
          if (!prog.exerciseAnswers[ansKey].includes(idx)) prog.exerciseAnswers[ansKey].push(idx);
          persist();
          renderApp();
        };
      });

      document.querySelectorAll("[data-wr-remove-tile]").forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          if (!prog) return;
          const ansKey = btn.getAttribute("data-wr-remove-tile");
          const pos = parseInt(btn.getAttribute("data-wr-tile-pos"), 10);
          const parentEx = btn.getAttribute("data-wr-parent");
          state.activeReorderKey = ansKey;
          if (parentEx && prog.checkedExercises[parentEx]) delete prog.checkedExercises[parentEx];
          if (Array.isArray(prog.exerciseAnswers[ansKey])) prog.exerciseAnswers[ansKey].splice(pos, 1);
          persist();
          renderApp();
        };
      });

      // Auto-mark released review as seen when viewing Writing section
      if (unit && state.currentWritingSection === "writing") {
        const rel = getReleasedWritingReview(unit.id);
        if (rel && !rel.student_seen_at) {
          markWritingReviewSeen(unit.id);
        }
      }

      // 6. Check / Submit & Reset Exercise
      document.querySelectorAll("[data-wr-check]").forEach(btn => {
        btn.onclick = async () => {
          if (!prog || !unit) return;
          const exKey = btn.getAttribute("data-wr-check");
          const isWritingTask = btn.getAttribute("data-wr-is-writing") === "1";
          const exId = btn.getAttribute("data-wr-ex-id") || exKey;

          if (isWritingTask) {
            const ta = document.querySelector(`[data-wr-writing-key="${exKey}_1"]`);
            const minW = ta ? parseInt(ta.getAttribute("data-wr-min-words") || "40", 10) : 40;
            const text = ta ? ta.value : prog.exerciseAnswers[`${exKey}_1`] || "";
            const wc = countWords(text);
            if (wc < minW) return;

            const writingEx = findPrimaryWritingExercise(unit) || { id: exId, instruction: "", promptBox: "" };
            const nowIso = new Date().toISOString();
            prog.submittedWritings[exId] = {
              wordCount: wc,
              text,
              submittedAt: nowIso
            };
            prog.checkedExercises[exKey] = true;
            if (!prog.completedSections.includes(state.currentWritingSection)) {
              prog.completedSections.push(state.currentWritingSection);
            }
            persist();

            cloudState.submittingUnitId = unit.id;
            delete cloudState.submitErrorByUnitId[unit.id];
            renderApp();

            const cloudRes = await submitWritingEssayToCloud(unit, writingEx, text, wc);
            cloudState.submittingUnitId = "";
            if (cloudRes && !cloudRes.ok && !cloudRes.skipped && cloudRes.error) {
              cloudState.submitErrorByUnitId[unit.id] = cloudRes.error;
            }
            renderApp();
            return;
          }

          prog.checkedExercises[exKey] = true;
          if (!prog.completedSections.includes(state.currentWritingSection)) {
            prog.completedSections.push(state.currentWritingSection);
          }
          persist();
          renderApp();
        };
      });

      document.querySelectorAll("[data-wr-reset]").forEach(btn => {
        btn.onclick = () => {
          if (!prog) return;
          const exKey = btn.getAttribute("data-wr-reset");
          delete prog.checkedExercises[exKey];
          Object.keys(prog.exerciseAnswers).forEach(k => {
            if (k.startsWith(exKey + "_")) delete prog.exerciseAnswers[k];
          });
          persist();
          renderApp();
        };
      });

      // 7. Bottom Prev / Next Step
      const btnWrPrev = document.getElementById("btn-wr-prev");
      if (btnWrPrev) btnWrPrev.onclick = previousWritingStep;
      const btnWrNext = document.getElementById("btn-wr-next");
      if (btnWrNext) btnWrNext.onclick = advanceWritingStep;
    }

    // Keyword Hub Controls
    const btnToggleKwFc = document.getElementById("btn-toggle-kwhub-flashcard");
    if (btnToggleKwFc) {
      btnToggleKwFc.onclick = () => {
        state.kwHubFlashcardMode = !state.kwHubFlashcardMode;
        state.kwHubCardFlipped = false;
        renderApp();
      };
    }

    document.querySelectorAll("[data-kw-filter]").forEach(btn => {
      btn.onclick = () => {
        state.kwHubFilter = btn.getAttribute("data-kw-filter") || "all";
        state.kwHubCardIdx = 0;
        state.kwHubCardFlipped = false;
        renderApp();
      };
    });

    const kwHubInp = document.getElementById("kwhub-search-input");
    if (kwHubInp) {
      kwHubInp.oninput = e => {
        state.kwHubSearch = e.target.value;
        const pos = e.target.selectionStart;
        renderApp();
        const nextEl = document.getElementById("kwhub-search-input");
        if (nextEl) {
          nextEl.focus();
          nextEl.setSelectionRange(pos, pos);
        }
      };
    }

    const btnFlipKw = document.getElementById("btn-flip-kwhub-card");
    if (btnFlipKw) {
      btnFlipKw.onclick = e => {
        if (e.target.closest("[data-speak-word]")) return;
        state.kwHubCardFlipped = !state.kwHubCardFlipped;
        renderApp();
      };
    }

    const btnKwPrev = document.getElementById("btn-kwhub-prev");
    if (btnKwPrev) {
      btnKwPrev.onclick = () => {
        state.kwHubCardIdx = Math.max(0, state.kwHubCardIdx - 1);
        state.kwHubCardFlipped = false;
        renderApp();
      };
    }

    const btnKwNext = document.getElementById("btn-kwhub-next");
    if (btnKwNext) {
      btnKwNext.onclick = () => {
        state.kwHubCardIdx++;
        state.kwHubCardFlipped = false;
        renderApp();
      };
    }

    // Universal TTS & Vocab Save Buttons
    document.querySelectorAll("[data-speak-word]").forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        const accent = el.getAttribute("data-speak-accent") || "US";
        speakEnglishText(el.getAttribute("data-speak-word"), 0.9, accent);
      };
    });

    document.querySelectorAll("[data-toggle-save-vocab]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const word = btn.getAttribute("data-toggle-save-vocab");
        const idx = stu.savedVocab.findIndex(v => v.word.toLowerCase() === word.toLowerCase());
        if (idx >= 0) {
          stu.savedVocab.splice(idx, 1);
        } else {
          stu.savedVocab.unshift({
            word,
            ipa: btn.getAttribute("data-vocab-ipa") || "",
            pos: btn.getAttribute("data-vocab-pos") || "",
            meaning: btn.getAttribute("data-vocab-meaning") || "",
            example: btn.getAttribute("data-vocab-example") || "",
            topic: btn.getAttribute("data-vocab-topic") || ""
          });
        }
        persist();
        renderApp();
      };
    });

    // Vocab Modal
    ["vocab-modal-backdrop", "btn-close-vocab-modal"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.onclick = () => { state.vocabModalOpen = false; renderApp(); };
    });

    document.querySelectorAll("[data-vocab-tab]").forEach(btn => {
      btn.onclick = () => {
        state.vocabModalTab = btn.getAttribute("data-vocab-tab");
        state.flashcardFlipped = false;
        renderApp();
      };
    });

    const vSearch = document.getElementById("vocab-search-input");
    if (vSearch) {
      vSearch.oninput = e => {
        state.vocabSearchQuery = e.target.value;
        const pos = e.target.selectionStart;
        renderApp();
        const el = document.getElementById("vocab-search-input");
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      };
    }

    const addCustomForm = document.getElementById("add-custom-vocab-form");
    if (addCustomForm) {
      addCustomForm.onsubmit = e => {
        e.preventDefault();
        const w = (document.getElementById("custom-vocab-word").value || "").trim();
        const ipa = (document.getElementById("custom-vocab-ipa").value || "").trim();
        const meaning = (document.getElementById("custom-vocab-meaning").value || "").trim();
        const example = (document.getElementById("custom-vocab-example").value || "").trim();
        if (!w || !meaning) return;
        stu.savedVocab = stu.savedVocab.filter(v => v.word.toLowerCase() !== w.toLowerCase());
        stu.savedVocab.unshift({ word: w, ipa, pos: "vocab", meaning, example, topic: "Tự thêm" });
        persist();
        renderApp();
      };
    }

    document.querySelectorAll("[data-remove-saved-vocab]").forEach(btn => {
      btn.onclick = () => {
        const w = btn.getAttribute("data-remove-saved-vocab");
        stu.savedVocab = stu.savedVocab.filter(v => v.word.toLowerCase() !== w.toLowerCase());
        persist();
        renderApp();
      };
    });

    const flipVocabFc = document.getElementById("btn-flip-vocab-fc");
    if (flipVocabFc) {
      flipVocabFc.onclick = () => { state.flashcardFlipped = !state.flashcardFlipped; renderApp(); };
    }
    const btnFcPrev = document.getElementById("btn-fc-prev");
    if (btnFcPrev) btnFcPrev.onclick = () => { state.flashcardIndex = Math.max(0, state.flashcardIndex - 1); state.flashcardFlipped = false; renderApp(); };
    const btnFcNext = document.getElementById("btn-fc-next");
    if (btnFcNext) btnFcNext.onclick = () => { state.flashcardIndex++; state.flashcardFlipped = false; renderApp(); };
  }

  // Global document click / Escape listeners
  document.addEventListener("click", e => {
    let changed = false;
    if (state.notifOpen && !e.target.closest("#topbar-notif-wrap")) {
      state.notifOpen = false;
      changed = true;
    }
    if (state.accountMenuOpen && !e.target.closest("#topbar-account-menu-wrap")) {
      state.accountMenuOpen = false;
      changed = true;
    }
    if (changed) renderApp();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (state.notifOpen || state.accountMenuOpen || state.vocabModalOpen) {
        state.notifOpen = false;
        state.accountMenuOpen = false;
        state.vocabModalOpen = false;
        renderApp();
      }
    }
  });

  async function loadCloudAccount(sessionUser) {
    const client = CLOUD ? CLOUD.getClient() : null;
    if (!client || !sessionUser) return;

    const uid = sessionUser.id;
    const email = String(sessionUser.email || "").trim().toLowerCase();
    const meta = sessionUser.user_metadata || {};
    const appMeta = sessionUser.app_metadata || {};
    const fallbackName =
      CLOUD.stripClassPrefix(meta.full_name || meta.name || "") ||
      email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    state.authLoading = true;
    renderApp();

    let resolvedName = fallbackName;
    let isTeacher = false;
    const subsMap = {};
    const reviewsMap = {};

    try {
      const [profRes, subsRes, reviewsRes, teacherRes] = await Promise.all([
        client.from("profiles").select("id, full_name").eq("id", uid).maybeSingle(),
        client.from("writing_submissions").select("*").eq("user_id", uid),
        client.from("writing_ai_reviews").select("*").eq("user_id", uid),
        client.rpc("is_teacher")
      ]);

      isTeacher =
        Boolean(teacherRes && !teacherRes.error && teacherRes.data === true) ||
        email === "mtung0208@gmail.com";

      const prof = profRes && profRes.data;
      if (prof && prof.full_name) {
        const cleanProfName = CLOUD.stripClassPrefix(prof.full_name);
        if (cleanProfName) resolvedName = cleanProfName;
        await client.from("profiles").update({ last_active_at: new Date().toISOString() }).eq("id", uid);
      } else {
        await client.from("profiles").upsert(
          {
            id: uid,
            email,
            full_name: resolvedName,
            avatar_url: meta.avatar_url || meta.picture || "",
            auth_provider: appMeta.provider || "email",
            last_active_at: new Date().toISOString()
          },
          { onConflict: "id" }
        );
      }

      if (Array.isArray(subsRes && subsRes.data)) {
        subsRes.data.forEach(row => {
          if (row && row.lesson_id) subsMap[row.lesson_id] = row;
        });
      }
      if (Array.isArray(reviewsRes && reviewsRes.data)) {
        reviewsRes.data.forEach(row => {
          if (row && row.lesson_id) reviewsMap[row.lesson_id] = row;
        });
      }
    } catch (e) {}

    currentAccount = { id: uid, name: resolvedName, email };
    cloudState.isTeacher = isTeacher;
    cloudState.submissionsByLessonId = subsMap;
    cloudState.reviewsByLessonId = reviewsMap;
    cloudState.lastReviewsRefreshMs = Date.now();
    reloadStoreForAccount();
    hydrateWritingProgressFromCloud();
    startCloudReviewPolling();
    state.authLoading = false;
    state.authError = "";
    renderApp();
  }

  window.addEventListener("focus", () => {
    if (currentAccount && !state.localPreviewMode) {
      refreshCloudWritingReviews(false);
    }
  });

  window.addEventListener("DOMContentLoaded", async () => {
    const params = new URLSearchParams(window.location.search);
    const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (isLocalhost && params.get("preview") === "demo") {
      state.localPreviewMode = true;
      currentAccount = { id: "preview-local", name: "Tài khoản Demo", email: "demo@local" };
      reloadStoreForAccount();
      renderApp();
      return;
    }

    if (!CLOUD) {
      state.authError = "Chưa tải được cấu hình Supabase.";
      renderApp();
      return;
    }

    const client = CLOUD.getClient();
    if (!client) {
      state.authError = "Chưa cấu hình kết nối Supabase.";
      renderApp();
      return;
    }

    let authLoadInFlight = false;
    async function handleSessionUser(sessionUser) {
      if (!sessionUser || authLoadInFlight) return;
      if (currentAccount && currentAccount.id === sessionUser.id) return;
      authLoadInFlight = true;
      try {
        await loadCloudAccount(sessionUser);
      } finally {
        authLoadInFlight = false;
      }
    }

    const oauthErr = CLOUD.extractOAuthErrorFromUrl ? CLOUD.extractOAuthErrorFromUrl() : "";
    if (oauthErr) {
      state.authError = "Đăng nhập Google không thành công: " + oauthErr;
    } else if (CLOUD.hasAuthCallbackParams && CLOUD.hasAuthCallbackParams()) {
      state.authLoading = true;
    }

    renderApp();

    client.auth.onAuthStateChange((event, session) => {
      if ((event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session && session.user) {
        setTimeout(() => {
          handleSessionUser(session.user);
        }, 0);
      } else if (event === "SIGNED_OUT") {
        currentAccount = null;
        state.authLoading = false;
        renderApp();
      } else if (event === "INITIAL_SESSION" && !session) {
        if (state.authLoading) {
          state.authLoading = false;
          renderApp();
        }
      }
    });

    const { data, error: sessErr } = await client.auth.getSession();
    if (sessErr && !state.authError) {
      state.authError = "Lỗi phiên đăng nhập: " + sessErr.message;
      state.authLoading = false;
      renderApp();
    } else if (data && data.session && data.session.user) {
      await handleSessionUser(data.session.user);
    } else if (state.authLoading && !(CLOUD.hasAuthCallbackParams && CLOUD.hasAuthCallbackParams())) {
      state.authLoading = false;
      renderApp();
    }
  });
})();
