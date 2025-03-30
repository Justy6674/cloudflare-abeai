export default {
  async fetch(request, env, ctx) {
    // Prepare CORS headers for allowed origins
    const allowedOrigins = [
      "https://abeai.health",
      "https://www.abeai.health",
      "https://abeai-chatbot-webflow-v8ks.vercel.app",
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

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Optionally handle GET/HEAD (e.g., health check)
    if (request.method === "GET" || request.method === "HEAD") {
      const headers = { "Content-Type": "application/json", ...corsHeaders };
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers });
    }

    // Only POST is allowed for chat interactions
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
        sessionId = (crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        newSession = true;
      }

      let sessionData = { messages: [], usageCount: 0 };
      const kvKey = `session:${sessionId}`;
      if (!newSession) {
        const stored = await env.ABEAI_KV.get(kvKey);
        if (stored) {
          try {
            sessionData = JSON.parse(stored);
          } catch (e) {
            console.error("Failed to parse session data for", sessionId, e);
            sessionData = { messages: [], usageCount: 0 };
          }
        }
      }

      const lowerMsg = userMessage.toLowerCase();
      const selfHarmKeywords = ["suicide", "suicidal", "kill myself", "end my life", "want to die", "hurt myself", "cut myself", "self harm", "self-harm"];
      const edKeywords = ["eating disorder", "eating disorders", "anorexia", "anorexic", "bulimia", "bulimic"];
      let crisisType = null;
      for (const kw of selfHarmKeywords) {
        if (lowerMsg.includes(kw)) { 
          crisisType = "self-harm";
          break;
        }
      }
      if (!crisisType) {
        for (const kw of edKeywords) {
          if (lowerMsg.includes(kw)) {
            crisisType = "eating-disorder";
            break;
          }
        }
      }

      let assistantReply = "";
      const freeLimit = 5;

      if (crisisType) {
        if (crisisType === "self-harm") {
          assistantReply = "I’m really sorry that you’re feeling like this. You’re not alone and there are people who care about you. It might help to reach out to a mental health professional or talk to someone you trust about how you feel. If you are thinking about harming yourself, please consider contacting a crisis line (for example, you can dial 988 in the US or reach out to Lifeline in Australia) or seek help from a medical professional immediately. You are important and help is available.";
        } else if (crisisType === "eating-disorder") {
          assistantReply = "I’m really sorry you’re struggling. You don’t have to go through this alone. It might help to reach out to a healthcare professional or a support organization that understands eating disorders. Talking to a doctor, a therapist, or an eating disorder helpline can be an important step. You deserve support and care – you’re not alone and there are people who want to help you.";
        }
      } else if (sessionData.usageCount >= freeLimit) {
        assistantReply = "I’m really sorry, but it looks like you’ve reached the limit of free questions I can answer for now. I truly wish I could keep helping you. Please consider subscribing to continue our conversation.";
      } else {
        const messagesForApi = sessionData.messages.slice(-9);
        messagesForApi.push({ role: "user", content: userMessage });

        const apiUrl = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/chat/completions";
        const apiRequestBody = {
          model: "gpt-4",
          messages: messagesForApi
        };

        // ✅ ONLY THIS PART IS CHANGED: Authorization header removed
        const apiResponse = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
            // Authorization header removed, Cloudflare handles auth internally
          },
          body: JSON.stringify(apiRequestBody)
        });

        if (!apiResponse.ok) {
          const errText = await apiResponse.text();
          console.error("OpenAI API error:", apiResponse.status, errText);
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
        assistantReply = completion.choices?.[0]?.message?.content || "I’m sorry, I’m having trouble generating a response right now.";
      }

      sessionData.messages.push({ role: "user", content: userMessage });
      sessionData.messages.push({ role: "assistant", content: assistantReply });
      if (sessionData.messages.length > 10) {
        sessionData.messages = sessionData.messages.slice(-10);
      }

      if (!crisisType && sessionData.usageCount < freeLimit) {
        sessionData.usageCount += 1;
      }

      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));

      const responseHeaders = { "Content-Type": "application/json", ...corsHeaders };
      if (newSession) {
        responseHeaders["Set-Cookie"] = `ABEAI_SESSION=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
      }

      return new Response(JSON.stringify({ message: assistantReply }), { status: 200, headers: responseHeaders });
    } catch (err) {
      console.error("Unhandled error in worker:", err);
      return new Response(JSON.stringify({ error: "Internal Server Error", message: err.message || "" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
