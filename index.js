export default {
  async fetch(request, env) {
    const allowedOrigins = [
      "https://abeai.health",
      "https://www.abeai.health",
      "https://abeai-chatbot-webflow-y8ks.vercel.app",
      "https://downscaleai.com"
    ];
    const origin = request.headers.get("Origin");
    const corsHeaders = {};
    if (origin && allowedOrigins.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      corsHeaders["Access-Control-Allow-Methods"] = "GET,HEAD,POST,OPTIONS";
      corsHeaders["Access-Control-Allow-Headers"] = "Content-Type";
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
      corsHeaders["Access-Control-Max-Age"] = "86400";
      corsHeaders["Vary"] = "Origin";
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const headers = { "Content-Type": "application/json", ...corsHeaders };
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    try {
      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.includes("application/json")) {
        return new Response(JSON.stringify({ error: "Invalid request format: expected JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const reqData = await request.json();
      const userMessage = reqData.message?.trim();
      if (!userMessage) {
        return new Response(JSON.stringify({ error: "Missing 'message' in request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      let sessionId;
      let newSession = false;
      const cookieHeader = request.headers.get("Cookie") || "";
      if (cookieHeader) {
        const cookies = cookieHeader.split(";").map(c => c.trim().split("="));
        for (const [name, value] of cookies) {
          if (name === "ABEAI_SESSION") {
            sessionId = value;
            break;
          }
        }
      }
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        newSession = true;
      }

      let sessionData = { messages: [], usageCount: 0 };
      const kvKey = `session:${sessionId}`;
      if (!newSession) {
        const stored = await env.ABEAI_KV.get(kvKey);
        if (stored) {
          sessionData = JSON.parse(stored);
        }
      }

      const freeLimit = 5;
      if (sessionData.usageCount >= freeLimit) {
        return new Response(JSON.stringify({
          message: "You've reached your free usage limit. Please consider upgrading.",
          upgradeSuggested: true
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const messagesForApi = sessionData.messages.slice(-9);
      messagesForApi.push({ role: "user", content: userMessage });

      // Corrected Cloudflare AI Gateway Endpoint (critical fix)
      const apiUrl = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/chat/completions";

      const apiResponse = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: messagesForApi
        })
      });

      if (!apiResponse.ok) {
        const errText = await apiResponse.text();
        return new Response(JSON.stringify({
          error: "Upstream AI request failed",
          status: apiResponse.status,
          details: errText.slice(0, 200)
        }), {
          status: apiResponse.status,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const completion = await apiResponse.json();

      // Critical fix: ensure correct parsing to avoid "undefined"
      const assistantReply = completion.choices?.[0]?.message?.content;
      if (!assistantReply) {
        throw new Error("AI response missing content");
      }

      sessionData.messages.push({ role: "user", content: userMessage });
      sessionData.messages.push({ role: "assistant", content: assistantReply });
      sessionData.usageCount += 1;

      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));

      const responseBody = { message: assistantReply };
      const responseHeaders = { "Content-Type": "application/json", ...corsHeaders };
      if (newSession) {
        responseHeaders["Set-Cookie"] = `ABEAI_SESSION=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
      }

      return new Response(JSON.stringify(responseBody), { status: 200, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Internal Server Error", message: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
