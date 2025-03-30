export default {
  async fetch(request, env) {
     // 1. Enhanced CORS Configuration
    const allowedOrigins = [
      "https://abeai.health",
      "https://www.abeai.health",
      "https://abeai-chatbot-webflow-v8ks.vercel.app"
    ];
    
    const origin = request.headers.get("Origin");
    const corsHeaders = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Origin",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin"
    };

    // Set Access-Control-Allow-Origin if origin is allowed
    if (origin && allowedOrigins.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    } else {
      return new Response("CORS not allowed", {
        status: 403,
        headers: {
          "Content-Type": "text/plain"
        }
      });
    }

    // 2. Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // 3. Only allow POST requests
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain"
        }
      });
    }
    
    try {
      // Parse the incoming request JSON (expects at least a "message" field from the user)
      const requestData = await request.json();
      const userMessage = requestData.message || "";
      // Determine user plan/tier from request (if not provided, default to "free")
      let userPlan = (requestData.plan || "free").toLowerCase();
      
      // Session management using a cookie (to track free usage per user/session)
      let sessionId;
      const cookieHeader = request.headers.get("Cookie") || "";
      const cookies = cookieHeader.split(";").map(c => c.trim());
      const sessionCookie = cookies.find(c => c.startsWith("sessionId="));
      if (sessionCookie) {
        // Existing session ID found
        sessionId = sessionCookie.split("=")[1];
      } else {
        // No session cookie – generate a new one
        sessionId = crypto.randomUUID();
        // Set a cookie on response so the browser will send it next time
        const cookieValue = `sessionId=${sessionId}; Path=/; Secure; HttpOnly; SameSite=None`;
        corsHeaders["Set-Cookie"] = cookieValue;
      }
      
      // Prepare KV storage keys for this session (for usage count and chat history)
      const usageKey = `usage:${sessionId}`;
      const historyKey = `history:${sessionId}`;
      let usageCount = 0;
      
      // Monetization: enforce free tier limits
      if (userPlan === "free") {
        const usageVal = await env.ABEAI_KV.get(usageKey);
        if (usageVal) {
          usageCount = parseInt(usageVal);
          if (isNaN(usageCount)) usageCount = 0;
        }
        if (usageCount >= 3) {
          // Free user has already received 3 responses – return an upsell message instead of calling OpenAI
          const country = request.cf && request.cf.country ? request.cf.country : "";
          const plansList = country === "AU"
            ? "Pay-As-You-Go, Essentials, Premium, or our Premium + Clinical plan"
            : "Pay-As-You-Go, Essentials, or Premium plans";
          const upsellMessage = `You've reached the limit of free responses. To continue using AbeAI, please upgrade to one of our ${plansList}.`;
          const result = { role: "assistant", content: upsellMessage };
          return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
        }
      }
      
      // Build conversation history from KV (for context in multi-turn conversations)
      let history = [];
      const historyData = await env.ABEAI_KV.get(historyKey);
      if (historyData) {
        try {
          history = JSON.parse(historyData);
        } catch (e) {
          history = [];  // fallback if stored data is somehow corrupted
        }
      }
      // Define the system prompt to enforce the four pillars and safety guidelines
      const systemPrompt = 
        "You are AbeAI, an AI assistant for healthy weight loss. You provide expert guidance in four areas: Clinical support, Nutrition, Physical Activity, and Mental Health. " +
        "Respond in an empathetic, friendly manner using Australian English. Always prioritize safety: if the user expresses self-harm or disordered eating intentions, respond with care, encourage seeking professional help, and maintain a supportive tone.";
      
      // Safety-first checks on the user message (handle sensitive content before calling AI)
      const lowerMsg = userMessage.toLowerCase();
      if (lowerMsg.includes("suicide") || lowerMsg.includes("harm myself") || lowerMsg.includes("kill myself")) {
        // Self-harm crisis detected – provide an immediate compassionate response and resource suggestion
        const safeReply = "I'm really sorry you're feeling like this. It might help to reach out to a mental health professional or talk to someone you trust. " +
                          "You are not alone, and there are people who want to help you. (If in Australia, you can call Lifeline at 13 11 14 any time for support.)";
        const result = { role: "assistant", content: safeReply };
        return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
      }
      if (lowerMsg.includes("starve") || lowerMsg.includes("vomit") || lowerMsg.includes("purge") || lowerMsg.includes("eating disorder")) {
        // Disordered-eating behavior detected – respond with caution and encouragement to seek help
        const safeReply = "I’m concerned by that. Remember, a healthy approach to weight loss is really important. You might consider talking to a healthcare provider or counselor about these feelings. Your well-being comes first, and there are safe ways to reach your goals with support.";
        const result = { role: "assistant", content: safeReply };
        return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
      }
      
      // Prepare the message array for OpenAI (system + history + new user message)
      const messages = [];
      messages.push({ role: "system", content: systemPrompt });
      if (history.length > 0) {
        // Include previous assistant and user messages for context
        messages.push(...history);
      }
      messages.push({ role: "user", content: userMessage });
      
      // Set max response length (tokens) based on user tier
      let maxTokens;
      switch (userPlan) {
        case "free":       maxTokens = 200; break;
        case "payg":       maxTokens = 500; break;
        case "essentials": maxTokens = 800; break;
        case "premium":    maxTokens = 1000; break;
        case "clinical":   maxTokens = 1000; break;
        default:           maxTokens = 500;  // default if plan is unrecognized
      }
      
      // Call OpenAI via Cloudflare's AI Gateway
      const openaiApiKey = env.OPENAI_KEY;  // OpenAI API key, stored as environment variable
      const openaiUrl = "https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/YOUR_GATEWAY_ID/openai/chat/completions";
      const payload = {
        model: "gpt-3.5-turbo",
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7
      };
      const apiResponse = await fetch(openaiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify(payload)
      });
      
      if (!apiResponse.ok) {
        // If OpenAI (via gateway) returns an error, log it and return an error message
        const errorText = await apiResponse.text();
        console.error("OpenAI API error:", apiResponse.status, errorText);
        return new Response(JSON.stringify({ error: "OpenAI API request failed", status: apiResponse.status }), { status: 500, headers: corsHeaders });
      }
      
      const responseData = await apiResponse.json();
      // Extract the assistant's reply from OpenAI response
      const assistantMessage = responseData.choices?.[0]?.message?.content || "";
      
      // Update conversation history (add the latest user and assistant messages)
      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: assistantMessage });
      // (Optional) Trim history to prevent unlimited growth (e.g., keep last 20 messages)
      if (history.length > 20) {
        history = history.slice(-20);
      }
      // Save updated history back to KV
      await env.ABEAI_KV.put(historyKey, JSON.stringify(history));
      
      // If free plan, increment the usage count now that a response was successfully generated
      if (userPlan === "free") {
        usageCount += 1;
        await env.ABEAI_KV.put(usageKey, usageCount.toString());
      }
      
      // Return the assistant's answer as JSON
      const result = { role: "assistant", content: assistantMessage };
      return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
    } catch (err) {
      // Catch-all for any unexpected errors
      console.error("Worker exception:", err);
      return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: corsHeaders });
    }
  }
}
