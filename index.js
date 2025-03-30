export default {
  async fetch(request, env, ctx) {
    // Allowed origins for CORS
    const allowedOrigins = [
      "https://abeai.health",
      "https://www.abeai.health",
      "https://abeai-chatbot-webflow-v8ks.vercel.app"
    ];
    const origin = request.headers.get("Origin");
    const corsBaseHeaders = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true"
    };
    // If origin is allowed, echo it; otherwise, no Access-Control-Allow-Origin header
    const corsHeaders = origin && allowedOrigins.includes(origin)
      ? { ...corsBaseHeaders, "Access-Control-Allow-Origin": origin }
      : corsBaseHeaders;
    
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { 
          ...corsHeaders, 
          "Access-Control-Max-Age": "86400"  // cache preflight response for 1 day 
        }
      });
    }
    
    // Only accept POST for the chatbot interaction
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }
    
    // Parse the request JSON (expected to contain the user's message)
    let userInput;
    try {
      const data = await request.json();
      // The user message might be under different keys; support a couple of common ones
      userInput = (data.message || data.prompt || "").trim();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (!userInput) {
      return new Response(JSON.stringify({ error: "No message provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    
    // Manage session cookie for user identification
    let sessionId;
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)session_id=([^;]+)/);
    if (cookieMatch) {
      sessionId = cookieMatch[1];
    }
    // If no session cookie, generate a new unique ID
    if (!sessionId) {
      sessionId = crypto.randomUUID();
    }
    const kvKey = `sess:${sessionId}`;
    
    // Retrieve session data from KV, or initialize if not present
    let sessionData = await env.ABEAI_KV.get(kvKey, { type: "json" });
    if (!sessionData) {
      sessionData = {
        plan: "free",
        usage: 0,
        messages: []
      };
      // Initialize conversation with a system prompt defining the assistant
      sessionData.messages.push({
        role: "system",
        content: "You are AbeAI, a compassionate and knowledgeable health assistant focused on weight loss and wellness. You provide supportive, evidence-based advice. Answer in a friendly, empathetic, and professional tone."
      });
    }
    
    // Safety check: detect self-harm or eating disorder crisis content in user input
    const lowerInput = userInput.toLowerCase();
    const selfHarmKeywords = ["suicide", "kill myself", "want to die", "don't want to live", "end my life", "hurt myself", "self-harm", "self harm"];
    const edKeywords = ["anorex", "bulimi", "starve", "vomit", "throw up", "purge", "laxative", "binge"];
    let safetyTriggered = false;
    let safetyReply = "";
    if (selfHarmKeywords.some(term => lowerInput.includes(term))) {
      safetyTriggered = true;
      // Craft an empathetic response for self-harm content
      safetyReply = "I'm really sorry that you're feeling like this. You are not alone, and there are people who care about you. It might help to talk with a mental health professional or someone you trust about how you feel. If you feel like you might harm yourself, please reach out to a crisis line like Lifeline (13 11 14) or seek professional help immediately. You deserve support, and there are people who want to help you.";
    } else if (edKeywords.some(term => lowerInput.includes(term))) {
      safetyTriggered = true;
      // Craft an empathetic response for eating disorder related content
      safetyReply = "I’m really sorry that you’re going through this. It sounds like you’re struggling with food or how you feel about your body. You’re not alone – many people go through this, and there are professionals who can help. It might be a good idea to reach out to a doctor or counselor to talk about these feelings. You deserve to be healthy and supported. If things feel very hard right now, you could also call the Butterfly Foundation’s Eating Disorder Helpline at 1800 33 4673 (1800 ED HOPE) for support.";
    }
    if (safetyTriggered) {
      // Append the user message and the safety response to the conversation history
      sessionData.messages.push({ role: "user", content: userInput });
      const assistantMsg = { role: "assistant", content: safetyReply };
      sessionData.messages.push(assistantMsg);
      // Save updated session to KV (not counting toward usage limit)
      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));
      // Set session cookie if new
      const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
      if (!cookieMatch) {
        // Cookie for 1 year, scoped to the site’s domain for persistence
        responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Domain=.abeai.health`;
      }
      // Return the empathetic safety response as the assistant's message
      return new Response(JSON.stringify(assistantMsg), { status: 200, headers: responseHeaders });
    }
    
    // No safety trigger: proceed with normal AI flow
    sessionData.messages.push({ role: "user", content: userInput });
    
    // Enforce monetization limits if enabled
    const plan = sessionData.plan || "free";
    const usageCount = sessionData.usage || 0;
    const forceMonetization = env.FORCE_MONETIZATION && env.FORCE_MONETIZATION.toString().toLowerCase() === "true";
    if (forceMonetization && plan === "free" && usageCount >= 3) {
      // Free user has reached the 3-response limit
      const upgradeMessage = {
        role: "assistant",
        content: "You have reached the limit of free messages. Please upgrade your plan to continue the conversation."
      };
      sessionData.messages.push(upgradeMessage);
      // (Do not increment usage for upgrade prompt; user must upgrade to continue.)
      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));
      const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
      if (!cookieMatch) {
        responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Domain=.abeai.health`;
      }
      return new Response(JSON.stringify(upgradeMessage), { status: 200, headers: responseHeaders });
    }
    
    // Determine max_tokens based on plan tier for the OpenAI API call
    const maxTokensMap = {
      free: 300,
      payg: 500,
      essentials: 750,
      premium: 1000,
      clinical: 1500
    };
    const max_tokens = maxTokensMap[plan] || 500;
    // Choose model (optionally vary by plan; default to GPT-3.5 for all here)
    const model = "gpt-3.5-turbo";
    
    // Prepare the request payload for OpenAI
    const apiPayload = {
      model: model,
      messages: sessionData.messages,
      max_tokens: max_tokens
      // You can add other OpenAI parameters here (temperature, etc.) if needed
    };
    
    let apiResponse;
    try {
      // Call the OpenAI Chat Completions API via Cloudflare AI Gateway
      apiResponse = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`
        },
        body: JSON.stringify(apiPayload)
      });
    } catch (err) {
      // Network or fetch error
      console.error("OpenAI API fetch error:", err);
      const errorMsg = {
        role: "assistant",
        content: "I'm sorry, I'm having trouble connecting to the AI service right now. Please try again later."
      };
      sessionData.messages.push(errorMsg);
      // (Not counting this as a used response since it's an error case)
      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));
      const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
      if (!cookieMatch) {
        responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Domain=.abeai.health`;
      }
      return new Response(JSON.stringify(errorMsg), { status: 200, headers: responseHeaders });
    }
    
    // Handle HTTP errors from the OpenAI API (e.g., 4xx or 5xx responses)
    if (!apiResponse.ok) {
      const status = apiResponse.status;
      let errorText = "";
      try {
        errorText = await apiResponse.text();
      } catch (_) { /* no body or JSON to parse */ }
      console.error("OpenAI API returned error:", status, errorText || "<no error text>");
      let assistantContent;
      if (status === 400 && errorText.includes("safety system")) {
        // OpenAI rejected the prompt due to content (policy violation)
        assistantContent = "I'm sorry, but I cannot assist with that request.";
      } else {
        // General API error (rate limit, server error, etc.)
        assistantContent = "I'm sorry, something went wrong while generating a response. Please try again.";
      }
      const errorMsg = { role: "assistant", content: assistantContent };
      sessionData.messages.push(errorMsg);
      // (Not incrementing usage due to failure to get a normal answer)
      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));
      const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
      if (!cookieMatch) {
        responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Domain=.abeai.health`;
      }
      return new Response(JSON.stringify(errorMsg), { status: 200, headers: responseHeaders });
    }
    
    // Parse the successful OpenAI response
    const result = await apiResponse.json();
    const assistantMessage = result.choices?.[0]?.message;
    if (!assistantMessage) {
      // Unexpected response format or empty result
      console.error("OpenAI API responded without a message:", JSON.stringify(result));
      const errorMsg = {
        role: "assistant",
        content: "I'm sorry, I couldn't retrieve an answer. Let's try again later."
      };
      sessionData.messages.push(errorMsg);
      // (Not incrementing usage for an empty result scenario)
      await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));
      const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
      if (!cookieMatch) {
        responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Domain=.abeai.health`;
      }
      return new Response(JSON.stringify(errorMsg), { status: 200, headers: responseHeaders });
    }
    
    // Append the assistant's answer to the conversation history and update usage
    sessionData.messages.push(assistantMessage);
    sessionData.usage = usageCount + 1;
    await env.ABEAI_KV.put(kvKey, JSON.stringify(sessionData));
    
    // Set cookie if new, and return the assistant's answer
    const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
    if (!cookieMatch) {
      responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Domain=.abeai.health`;
    }
    return new Response(JSON.stringify(assistantMessage), { status: 200, headers: responseHeaders });
  }
};
