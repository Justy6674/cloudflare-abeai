export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",  // adjust origin as needed (e.g. your domain) 
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true"
        }
      });
    }

    // 2. Only allow POST requests
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true"
        }
      });
    }

    // 3. Parse the JSON request body for the user message
    let requestData;
    try {
      requestData = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON request" }), {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Content-Type": "application/json"
        }
      });
    }
    const userMessage = requestData.message || requestData.prompt || requestData.content;
    if (!userMessage) {
      return new Response(JSON.stringify({ error: "No message provided" }), {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Content-Type": "application/json"
        }
      });
    }

    // 4. Safety checks for self-harm or eating disorder triggers
    const msgLower = userMessage.toLowerCase();
    const selfHarmTriggers = ["suicide", "kill myself", "want to die", "self-harm", "self harm"];
    const edTriggers = ["eating disorder", "anorexia", "bulimia"];
    if (selfHarmTriggers.some(t => msgLower.includes(t))) {
      // Return a pre-defined supportive message instead of calling OpenAI
      const safeResponse = "I'm really sorry you're feeling like this. Please remember you are not alone and there are people who care about you. It might help to reach out to a mental health professional or someone you trust. If you are considering harming yourself, please seek help immediately (for example, you can call a crisis line like Lifeline at 13 11 14). You are important and help is available.";
      return new Response(JSON.stringify({ role: "assistant", content: safeResponse }), {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Content-Type": "application/json"
        }
      });
    }
    if (edTriggers.some(t => msgLower.includes(t))) {
      const safeResponse = "I’m sorry that you’re struggling. Coping with an eating disorder is very difficult, but support is available. Please consider reaching out to a healthcare professional or a support organization like the Butterfly Foundation (call 1800 33 4673) for help. You’re not alone, and with support, recovery is possible.";
      return new Response(JSON.stringify({ role: "assistant", content: safeResponse }), {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Content-Type": "application/json"
        }
      });
    }

    // 5. Session cookie handling and KV usage tracking
    let sessionId;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookieMatch = cookieHeader.match(/abeai_session=([^;]+)/);
    if (cookieMatch) {
      sessionId = cookieMatch[1];
    }
    if (!sessionId) {
      // Generate a new session ID if none exists
      sessionId = crypto.randomUUID ? crypto.randomUUID() : (Math.random() + 1).toString(36).substring(2);
    }
    // Fetch current usage count from KV (default to 0 if not set)
    let usageCount = 0;
    if (env.ABEAI_USAGE_KV) {
      try {
        const stored = await env.ABEAI_USAGE_KV.get(sessionId);
        usageCount = stored ? parseInt(stored) : 0;
        if (isNaN(usageCount)) usageCount = 0;
      } catch (err) {
        console.error("KV get error:", err);
        usageCount = 0;
      }
    }
    const FREE_LIMIT = 5;  // allow 5 free messages per session
    if (usageCount >= FREE_LIMIT) {
      // Free limit reached – return an error or upgrade prompt
      const limitResponse = "You have used all your free messages for now. Please upgrade your plan to continue using the service.";
      return new Response(JSON.stringify({ error: "free_limit_reached", message: limitResponse }), {
        status: 403,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Content-Type": "application/json"
        }
      });
    }

    // 6. Prepare the OpenAI API request payload (including system prompt)
    const systemPrompt = "You are AbeAI, a compassionate and knowledgeable health assistant focused on weight loss and wellness. You provide supportive, evidence-based advice. Answer in a friendly, empathetic, and professional tone.";
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ];
    const openAiPayload = {
      model: "gpt-4",  // using GPT-4 model via OpenAI
      messages: messages
      // (You can add other parameters like temperature, etc., if needed)
    };

    // 7. Call the OpenAI API via Cloudflare AI Gateway (fixed endpoint & auth)
    const openAiUrl = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/chat/completions";
    const openAiHeaders = {
      "Content-Type": "application/json",
      // Use OpenAI API key for authorization (Cloudflare will forward this to OpenAI) [oai_citation_attribution:3‡developers.cloudflare.com](https://developers.cloudflare.com/ai-gateway/providers/openai/#:~:text=Request)
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      // If using an *Authenticated* AI Gateway, include your CF token:
      // "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`
    };
    let assistantReply;
    try {
      const openAiResponse = await fetch(openAiUrl, {
        method: "POST",
        headers: openAiHeaders,
        body: JSON.stringify(openAiPayload)
      });
      if (!openAiResponse.ok) {
        // Handle errors from OpenAI (e.g., invalid API key, rate limit, etc.)
        const errText = await openAiResponse.text();
        console.error("OpenAI API error:", openAiResponse.status, errText);
        return new Response(JSON.stringify({
          error: "openai_error",
          message: "Failed to get a response from the AI service."
        }), {
          status: openAiResponse.status,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Credentials": "true",
            "Content-Type": "application/json"
          }
        });
      }
      const data = await openAiResponse.json();
      assistantReply = data.choices?.[0]?.message?.content;
      if (!assistantReply) {
        throw new Error("No content in OpenAI response");
      }
    } catch (err) {
      console.error("Error during OpenAI fetch:", err);
      return new Response(JSON.stringify({
        error: "internal_error",
        message: "An error occurred while processing your request."
      }), {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Credentials": "true",
          "Content-Type": "application/json"
        }
      });
    }

    // 8. On success, increment the usage count in KV (one more message used)
    usageCount += 1;
    if (env.ABEAI_USAGE_KV) {
      env.ABEAI_USAGE_KV.put(sessionId, usageCount.toString()).catch(err => {
        console.error("KV put error:", err);
      });
    }

    // 9. Return the assistant's response to the frontend
    const jsonResponse = JSON.stringify({ role: "assistant", content: assistantReply });
    const responseHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Content-Type": "application/json"
    };
    // Set session cookie if this is a new session (so the client maintains the same session ID)
    if (!cookieMatch) {
      responseHeaders["Set-Cookie"] = `abeai_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None`;
    }
    return new Response(jsonResponse, { status: 200, headers: responseHeaders });
  }
};
