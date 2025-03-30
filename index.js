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
          "Content-Type": "text/plain",
          ...corsHeaders
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
      // Parse the incoming request JSON
      let requestData;
      try {
        requestData = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }

      const userMessage = requestData.message || "";
      const userPlan = (requestData.plan || "free").toLowerCase();
      
      // Session management
      let sessionId;
      const cookieHeader = request.headers.get("Cookie") || "";
      const sessionCookie = cookieHeader.split(";")
        .map(c => c.trim())
        .find(c => c.startsWith("sessionId="));
      
      if (sessionCookie) {
        sessionId = sessionCookie.split("=")[1];
      } else {
        sessionId = crypto.randomUUID();
        corsHeaders["Set-Cookie"] = `sessionId=${sessionId}; Path=/; Secure; HttpOnly; SameSite=None`;
      }
      
      // KV storage setup
      const usageKey = `usage:${sessionId}`;
      const historyKey = `history:${sessionId}`;
      let usageCount = 0;
      
      // Monetization logic
      if (userPlan === "free") {
        const usageVal = await env.ABEAI_KV.get(usageKey);
        usageCount = parseInt(usageVal) || 0;
        
        if (usageCount >= 3) {
          const country = request.cf?.country || "";
          const plansList = country === "AU"
            ? "Pay-As-You-Go, Essentials, Premium, or our Premium + Clinical plan"
            : "Pay-As-You-Go, Essentials, or Premium plans";
          
          return new Response(JSON.stringify({
            role: "assistant",
            content: `You've reached the limit of free responses. To continue using AbeAI, please upgrade to one of our ${plansList}.`
          }), {
            status: 200,
            headers: corsHeaders
          });
        }
      }
      
      // Conversation history
      let history = [];
      try {
        const historyData = await env.ABEAI_KV.get(historyKey);
        history = historyData ? JSON.parse(historyData) : [];
      } catch (e) {
        console.error("History parse error:", e);
      }

      // System prompt
      const systemPrompt = `You are AbeAI, an AI health coach specializing in:
- Clinical support
- Nutrition guidance
- Physical Activity
- Mental Health
Use Australian English and maintain a supportive tone.`;

      // Safety checks
      const lowerMsg = userMessage.toLowerCase();
      if (/suicide|harm myself|kill myself/.test(lowerMsg)) {
        return new Response(JSON.stringify({
          role: "assistant",
          content: "I'm really sorry you're feeling this way. Please contact Lifeline at 13 11 14 or talk to someone you trust."
        }), {
          status: 200,
          headers: corsHeaders
        });
      }

      if (/starve|vomit|purge|eating disorder/.test(lowerMsg)) {
        return new Response(JSON.stringify({
          role: "assistant",
          content: "I'm concerned by this. Please consult a healthcare professional for proper support."
        }), {
          status: 200,
          headers: corsHeaders
        });
      }
      
      // Prepare messages for OpenAI
      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage }
      ];

      // Set response length by tier
      const maxTokens = {
        free: 200,
        payg: 500,
        essentials: 800,
        premium: 1000,
        clinical: 1000
      }[userPlan] || 500;

      // OpenAI API Call via Cloudflare Gateway
      const openaiUrl = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/chat/completions";
      
      console.log("Sending to OpenAI:", {
        model: "gpt-3.5-turbo",
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7
      });

      const apiResponse = await fetch(openaiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: messages,
          max_tokens: maxTokens,
          temperature: 0.7
        })
      });

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        console.error("OpenAI Error:", apiResponse.status, errorText);
        throw new Error(`OpenAI API failed: ${apiResponse.status}`);
      }

      const responseData = await apiResponse.json();
      const assistantMessage = responseData.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";

      // Update history
      history.push(
        { role: "user", content: userMessage },
        { role: "assistant", content: assistantMessage }
      );
      history = history.slice(-20); // Keep last 10 exchanges

      await env.ABEAI_KV.put(historyKey, JSON.stringify(history));
      
      if (userPlan === "free") {
        await env.ABEAI_KV.put(usageKey, (usageCount + 1).toString());
      }

      return new Response(JSON.stringify({
        role: "assistant",
        content: assistantMessage
      }), {
        status: 200,
        headers: corsHeaders
      });

    } catch (err) {
      console.error("Worker Error:", err);
      return new Response(JSON.stringify({
        error: "Internal server error",
        details: err.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
}
