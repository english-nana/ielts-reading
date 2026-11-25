// ============================================================================
// SUPABASE EDGE FUNCTION: grade-writing
// Sửa bài viết tiếng Anh Sơ cấp (Units 01–10 · A1–A2 Foundation Writing):
// - KHÔNG chấm điểm / KHÔNG ghi band điểm, chỉ tập trung sửa lỗi & gợi ý dễ hiểu
// - Hẹn trả bài sửa cho học viên sau 12 tiếng (Giáo viên xem và trả sớm được ngay)
// - Hỗ trợ hàng đợi tự động sửa lại (pg_cron mỗi 5 phút) khi AI quá tải (503 / 429)
//
// Triển khai trên Supabase Dashboard (project plqpsxcvdwhtclokwafy):
// 1. Vào Edge Functions -> Secrets:
//    - GEMINI_API_KEY = <API key từ https://aistudio.google.com/apikey>
//    - CRON_SECRET    = <một chuỗi bí mật bất kỳ, VD: ielts-writing-retry-2026>
// 2. Tạo Edge Function tên "grade-writing" -> dán toàn bộ file này -> Deploy.
// 3. Tắt "Verify JWT with legacy secret" trong tab Settings / Details của grade-writing.
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const RELEASE_DELAY_HOURS = 12;
const MAX_STUDENT_GRADES_PER_LESSON = 5;
const MAX_AUTO_RETRIES = 20;
const RETRY_COOLDOWN_MS = 90 * 1000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

function buildElementaryCorrectionPrompt(params: {
  lessonTitle: string;
  promptText: string;
  content: string;
}) {
  return `Bạn là giáo viên dạy viết tiếng Anh Sơ cấp (trình độ A1–A2 Foundation) tận tâm, sửa bài nhẹ nhàng, rõ ràng, dễ hiểu cho học viên Việt Nam mới luyện viết.

THÔNG TIN BÀI LÀM:
- Bài học / Chủ đề: ${params.lessonTitle}
- Yêu cầu đề bài:
"""
${params.promptText || "(Không có mô tả đề bài)"}
"""

BÀI VIẾT CỦA HỌC VIÊN:
"""
${params.content}
"""

NGUYÊN TẮC SỬA BÀI BẮT BUỘC (VIẾT SƠ CẤP — KHÔNG CHẤM ĐIỂM):
1. KHÔNG chấm điểm, KHÔNG ghi band điểm IELTS, KHÔNG đánh giá theo thang điểm số. Chỉ tập trung sửa lỗi và khích lệ học viên.
2. CHỈ SỬA những lỗi thực sự cần thiết thuộc 4 nhóm sau:
   - "Ngữ pháp": sai động từ to be (am/is/are), sai thì hiện tại đơn, thiếu s/es, thiếu chủ ngữ/động từ, sai mạo từ (a/an/the), sai giới từ cơ bản (in/on/at/from), nối câu sai.
   - "Chính tả": sai chính tả tiếng Anh hoặc viết sai dạng từ rõ rệt.
   - "Dấu câu": thiếu/sai dấu chấm cuối câu, dấu phẩy, quên viết hoa chữ cái đầu câu hoặc tên riêng.
   - "Từ vựng": dùng sai từ, dịch sát từng từ tiếng Việt sang tiếng Anh (word-by-word) khiến câu sai nghĩa.
3. TUYỆT ĐỐI KHÔNG ÉP NÂNG CẤP THÀNH VĂN HỌC THUẬT: Đây là bài viết sơ cấp (A1–A2). Nếu câu học viên viết đơn giản, ngắn gọn nhưng ĐÚNG ngữ pháp và rõ nghĩa thì GIỮ NGUYÊN, KHÔNG SỬA. Không viết lại toàn bộ câu nếu chỉ sai 1–2 từ; trích đoạn ngắn vừa đủ (2 đến 10 từ) để học viên thấy ngay chỗ sai.
4. Với mỗi lỗi trong mảng "corrections":
   - Trường "original" PHẢI trích CHÍNH XÁC từng ký tự (verbatim) từ bài viết của học viên để hệ thống đánh dấu gạch lỗi trực tiếp trên bài gốc.
   - Trường "corrected" là cụm từ đã sửa chuẩn xác, đơn giản, tự nhiên ở mức sơ cấp A1–A2.
   - Trường "explanation_vi" giải thích ngắn gọn, dễ hiểu bằng tiếng Việt TẠI SAO SAI và CÁCH NHỚ cho người mới học.
5. Về phần gợi ý bổ sung ý ("idea_additions"):
   - Đối chiếu bài viết với đề bài gốc. Chỉ liệt kê (tối đa 2–3 mục) nếu học viên bỏ sót yêu cầu bắt buộc của đề bài hoặc viết quá cụt. Câu gợi ý tiếng Anh phải thật đơn giản ở mức A1–A2 để học viên dễ áp dụng. Nếu bài đã đủ ý tốt, trả về mảng rỗng [].
6. Trường "revised_version": Giữ nguyên ý tưởng gốc của học viên, chỉ áp dụng các lỗi đã sửa và chỉnh câu tự nhiên ở mức sơ cấp A1–A2. Phân tách các đoạn bằng "\\n\\n".

TRẢ VỀ DUY NHẤT MỘT JSON HỢP LỆ (không thêm markdown hay văn bản ngoài JSON) theo đúng cấu trúc sau:
{
  "overall_comment": "2-3 câu nhận xét tổng quan khích lệ bằng tiếng Việt (KHÔNG ghi điểm số): khen điểm làm tốt trước, sau đó nêu 1-2 lỗi cơ bản quan trọng nhất cần chú ý.",
  "criteria": {
    "task_fulfillment": "Nhận xét ngắn gọn tiếng Việt về mức độ viết đủ ý theo yêu cầu đề bài",
    "vocabulary": "Nhận xét ngắn gọn về cách dùng từ vựng & cụm từ của bài học",
    "grammar": "Nhận xét ngắn gọn về ngữ pháp, chính tả & dấu câu cơ bản"
  },
  "corrections": [
    {
      "id": 1,
      "original": "trích nguyên văn từ bài học viên",
      "corrected": "cách sửa chuẩn sơ cấp",
      "category": "Ngữ pháp",
      "explanation_vi": "Giải thích ngắn gọn dễ hiểu tại sao sai và cách sửa đúng"
    }
  ],
  "idea_additions": [
    {
      "where_vi": "Vị trí nên bổ sung (VD: Cuối đoạn văn)",
      "issue_vi": "Ý đề bài còn thiếu hoặc viết còn quá ngắn",
      "suggested_sentences_en": "1-2 câu tiếng Anh đơn giản mức A1-A2 để học viên thêm vào",
      "meaning_vi": "Nghĩa tiếng Việt của câu gợi ý"
    }
  ],
  "revised_version": "Toàn bộ bài viết sau khi áp dụng các sửa đổi (giữ nguyên ý của học viên)"
}`;
}

function parseModelJson(rawText: string) {
  const trimmed = String(rawText || "").trim();
  const unfenced = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(unfenced);
}

interface SubmissionRow {
  id: string;
  user_id: string;
  lesson_id: string;
  lesson_title?: string;
  prompt_text?: string;
  content?: string;
  submitted_at?: string;
  ai_release_at?: string;
}

interface ReviewRow {
  submission_id: string;
  grade_count?: number;
  retry_count?: number;
  release_at?: string;
  status?: string;
  updated_at?: string;
}

async function correctSingleSubmission(
  admin: SupabaseClient,
  geminiApiKey: string,
  geminiModel: string,
  sub: SubmissionRow,
  existingReview: ReviewRow | null,
  options: { isTeacherOrCron: boolean; releaseNow: boolean }
) {
  const content = String(sub.content || "").trim();
  const words = content.split(/\s+/).filter(Boolean).length;
  if (words < 15) {
    return { ok: false, status: 400, error: "Bài viết quá ngắn để sửa lỗi (cần ít nhất 15 từ)." };
  }

  const prevCount = existingReview?.grade_count || 0;
  const prevRetry = existingReview?.retry_count || 0;

  if (!options.isTeacherOrCron && prevCount >= MAX_STUDENT_GRADES_PER_LESSON) {
    return {
      ok: false,
      status: 429,
      error: `Bạn đã dùng hết ${MAX_STUDENT_GRADES_PER_LESSON} lượt sửa bài tự động cho bài học này.`
    };
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const submittedMs = new Date(sub.submitted_at || nowMs).getTime();
  const baseSubmitMs = isNaN(submittedMs) ? nowMs : submittedMs;

  let releaseAtIso = new Date(baseSubmitMs + RELEASE_DELAY_HOURS * 60 * 60 * 1000).toISOString();
  if (options.isTeacherOrCron && options.releaseNow) {
    releaseAtIso = nowIso;
  } else if (existingReview?.release_at) {
    releaseAtIso = existingReview.release_at;
  } else if (sub.ai_release_at) {
    releaseAtIso = sub.ai_release_at;
  }

  await admin
    .from("writing_submissions")
    .update({
      ai_status: "grading",
      ai_release_at: releaseAtIso
    })
    .eq("id", sub.id);

  const prompt = buildElementaryCorrectionPrompt({
    lessonTitle: sub.lesson_title || sub.lesson_id,
    promptText: sub.prompt_text || "",
    content
  });

  const fallbackModels = Array.from(
    new Set([geminiModel, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"])
  );

  let geminiRes: Response | null = null;
  let lastStatus = 500;
  let lastErrText = "";

  for (const modelName of fallbackModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: "application/json"
          }
        })
      });
      if (res.ok) {
        geminiRes = res;
        break;
      }
      lastStatus = res.status;
      lastErrText = await res.text().catch(() => "");
      if ((res.status === 503 || res.status === 429 || res.status === 500) && attempt === 0) {
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
      break;
    }
    if (geminiRes) break;
  }

  if (!geminiRes) {
    const nextRetry = prevRetry + 1;
    await admin.from("writing_ai_reviews").upsert(
      {
        submission_id: sub.id,
        user_id: sub.user_id,
        lesson_id: sub.lesson_id,
        lesson_title: sub.lesson_title || sub.lesson_id,
        status: "error",
        release_at: releaseAtIso,
        error_message: `Gemini API lỗi (${lastStatus}): ${lastErrText.slice(0, 220)}`,
        grade_count: prevCount,
        retry_count: nextRetry,
        updated_at: nowIso
      },
      { onConflict: "submission_id" }
    );
    await admin
      .from("writing_submissions")
      .update({ ai_status: "pending_retry", ai_release_at: releaseAtIso })
      .eq("id", sub.id);

    return {
      ok: false,
      status: 502,
      error: `AI tạm quá tải (${lastStatus}) — đã xếp hàng đợi tự sửa lại (lần ${nextRetry}/${MAX_AUTO_RETRIES}).`
    };
  }

  const geminiJson = await geminiRes.json();
  const rawCandidate = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsedReview = parseModelJson(rawCandidate);

  const normalizedReview = {
    overall_comment: String(parsedReview?.overall_comment || ""),
    criteria: {
      task_fulfillment: String(parsedReview?.criteria?.task_fulfillment || ""),
      vocabulary: String(parsedReview?.criteria?.vocabulary || ""),
      grammar: String(parsedReview?.criteria?.grammar || "")
    },
    corrections: Array.isArray(parsedReview?.corrections)
      ? parsedReview.corrections
          .map((c: Record<string, unknown>, idx: number) => ({
            id: Number(c?.id) || idx + 1,
            original: String(c?.original || "").trim(),
            corrected: String(c?.corrected || "").trim(),
            category: String(c?.category || "Ngữ pháp").trim(),
            explanation_vi: String(c?.explanation_vi || "").trim()
          }))
          .filter((c: { original: string; corrected: string }) => c.original && c.corrected && c.original !== c.corrected)
      : [],
    idea_additions: Array.isArray(parsedReview?.idea_additions)
      ? parsedReview.idea_additions
          .map((it: Record<string, unknown>) => ({
            where_vi: String(it?.where_vi || "").trim(),
            issue_vi: String(it?.issue_vi || "").trim(),
            suggested_sentences_en: String(it?.suggested_sentences_en || "").trim(),
            meaning_vi: String(it?.meaning_vi || "").trim()
          }))
          .filter((it: { suggested_sentences_en: string; issue_vi: string }) => it.suggested_sentences_en || it.issue_vi)
      : [],
    revised_version: String(parsedReview?.revised_version || "").trim()
  };

  const nextCount = options.isTeacherOrCron ? Math.max(1, prevCount) : prevCount + 1;
  const isAlreadyReleased = new Date(releaseAtIso).getTime() <= Date.now();

  const { error: upsertRevErr } = await admin.from("writing_ai_reviews").upsert(
    {
      submission_id: sub.id,
      user_id: sub.user_id,
      lesson_id: sub.lesson_id,
      lesson_title: sub.lesson_title || sub.lesson_id,
      status: "ready",
      release_at: releaseAtIso,
      review_json: normalizedReview,
      error_message: "",
      grade_count: nextCount,
      retry_count: 0,
      student_seen_at: null,
      updated_at: nowIso
    },
    { onConflict: "submission_id" }
  );

  if (upsertRevErr) {
    return {
      ok: false,
      status: 500,
      error: `Lỗi lưu bài sửa vào writing_ai_reviews: ${upsertRevErr.message}`
    };
  }

  const { error: updSubErr } = await admin
    .from("writing_submissions")
    .update({
      ai_status: isAlreadyReleased ? "ready" : "scheduled",
      ai_release_at: releaseAtIso
    })
    .eq("id", sub.id);

  if (updSubErr) {
    return {
      ok: false,
      status: 500,
      error: `Lỗi cập nhật trạng thái writing_submissions: ${updSubErr.message}`
    };
  }

  return {
    ok: true,
    status: 200,
    ai_status: isAlreadyReleased ? "ready" : "scheduled",
    release_at: releaseAtIso,
    review_json: normalizedReview
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY") || "";
    const geminiModel = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const cronSecretEnv = Deno.env.get("CRON_SECRET") || "";

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return jsonResponse({ ok: false, error: "Thiếu cấu hình Supabase trên Edge Function." }, 500);
    }
    if (!geminiApiKey) {
      return jsonResponse({ ok: false, error: "Chưa cấu hình GEMINI_API_KEY trong Supabase Edge Functions Secrets." }, 500);
    }

    const admin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "single").trim();

    const incomingCronSecret = req.headers.get("x-cron-secret") || "";
    const isCronCall = Boolean(cronSecretEnv && incomingCronSecret && incomingCronSecret === cronSecretEnv);

    let callerId = "";
    let callerEmail = "";
    let isTeacher = false;

    if (!isCronCall) {
      const authHeader = req.headers.get("Authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        return jsonResponse({ ok: false, error: "Chưa đăng nhập." }, 401);
      }
      const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
      const { data: authData, error: authErr } = await admin.auth.getUser(jwt);
      if (authErr || !authData?.user) {
        return jsonResponse({ ok: false, error: "Phiên đăng nhập không hợp lệ: " + (authErr?.message || "") }, 401);
      }
      callerId = authData.user.id;
      callerEmail = String(authData.user.email || "").trim().toLowerCase();
      const { data: teacherRow } = await admin
        .from("teachers")
        .select("email")
        .ilike("email", callerEmail)
        .maybeSingle();
      isTeacher = Boolean(teacherRow) || callerEmail === "mtung0208@gmail.com";
    }

    // MODE 1: HÀNG ĐỢI TỰ ĐỘNG SỬA LẠI (pg_cron mỗi 5 phút hoặc Giáo viên bấm)
    if (mode === "process_queue") {
      if (!isCronCall && !isTeacher) {
        return jsonResponse({ ok: false, error: "Chỉ hệ thống hoặc Giáo viên được chạy hàng đợi sửa bài." }, 403);
      }

      const batchSize = Math.max(1, Math.min(5, Number(body?.batch_size) || 3));

      const [{ data: allSubs, error: subsErr }, { data: allReviews }] = await Promise.all([
        admin
          .from("writing_submissions")
          .select("*")
          .eq("is_submitted", true)
          .order("submitted_at", { ascending: true })
          .limit(120),
        admin.from("writing_ai_reviews").select("submission_id, status, retry_count, grade_count, release_at, updated_at")
      ]);

      if (subsErr) {
        return jsonResponse({ ok: false, error: "Lỗi đọc danh sách bài chờ sửa: " + subsErr.message }, 500);
      }

      const reviewBySubId: Record<string, ReviewRow> = {};
      (allReviews || []).forEach((r: ReviewRow) => {
        if (r && r.submission_id) reviewBySubId[r.submission_id] = r;
      });

      const nowMs = Date.now();
      const pendingSubs = (allSubs || []).filter((sub: SubmissionRow) => {
        const rev = reviewBySubId[sub.id];
        if (rev && rev.status === "ready") return false;
        if (rev && (rev.retry_count || 0) >= MAX_AUTO_RETRIES) return false;
        if (rev && rev.updated_at && !isTeacher) {
          const lastTryMs = new Date(rev.updated_at).getTime();
          if (!isNaN(lastTryMs) && nowMs - lastTryMs < RETRY_COOLDOWN_MS) return false;
        }
        return true;
      });

      const slice = pendingSubs.slice(0, batchSize);
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];

      for (let i = 0; i < slice.length; i++) {
        const sub = slice[i];
        const res = await correctSingleSubmission(
          admin,
          geminiApiKey,
          geminiModel,
          sub,
          reviewBySubId[sub.id] || null,
          { isTeacherOrCron: true, releaseNow: false }
        );
        results.push({ id: sub.id, ok: res.ok, error: res.ok ? undefined : res.error });
        if (i < slice.length - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      return jsonResponse({
        ok: true,
        mode: "process_queue",
        pending_total: pendingSubs.length,
        processed: results.length,
        succeeded: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        results
      });
    }

    // MODE 2: SỬA 1 BÀI CỤ THỂ (Học viên vừa nộp hoặc Giáo viên bấm sửa)
    const submissionId = String(body?.submission_id || "").trim();
    const releaseNow = Boolean(body?.release_now);

    if (!submissionId) {
      return jsonResponse({ ok: false, error: "Thiếu submission_id." }, 400);
    }

    const [{ data: sub, error: subErr }, { data: existingReview }] = await Promise.all([
      admin.from("writing_submissions").select("*").eq("id", submissionId).maybeSingle(),
      admin
        .from("writing_ai_reviews")
        .select("submission_id, grade_count, retry_count, release_at, status, updated_at")
        .eq("submission_id", submissionId)
        .maybeSingle()
    ]);

    if (subErr) {
      return jsonResponse(
        { ok: false, error: `Lỗi đọc writing_submissions (${subErr.code || "DB"}): ${subErr.message}` },
        500
      );
    }
    if (!sub) {
      return jsonResponse({ ok: false, error: `Không tìm thấy bài viết trên hệ thống (id: ${submissionId}).` }, 404);
    }
    if (sub.user_id !== callerId && !isTeacher) {
      return jsonResponse({ ok: false, error: "Bạn không có quyền sửa bài viết này." }, 403);
    }

    const gradeRes = await correctSingleSubmission(admin, geminiApiKey, geminiModel, sub, existingReview || null, {
      isTeacherOrCron: isTeacher,
      releaseNow
    });

    if (!gradeRes.ok) {
      return jsonResponse({ ok: false, error: gradeRes.error }, gradeRes.status || 500);
    }

    return jsonResponse({
      ok: true,
      status: gradeRes.ai_status,
      release_at: gradeRes.release_at,
      review_json: isTeacher ? gradeRes.review_json : undefined
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Lỗi không xác định khi sửa bài.";
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});
