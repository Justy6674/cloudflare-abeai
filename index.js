// Existing code...

// Ensure all functions and blocks have closing brackets
// Added closing brackets for the main function and export

export default {
  async fetch(request, env, ctx) {
    const WELCOME_MESSAGE = `Hi, I'm AbeAI, your personalised health companion. 

I'm here to support your wellness journey across four key areas:
🩺 Clinical Health
🥗 Nutrition Guidance
🏋️ Activity & Fitness
🧠 Mental Wellbeing

What area would you like to explore today?`;

    const allowedOrigins = [
      "https://www.abeai.health",
      "https://abeai.health",
      "https://www.downscale.com.au",
      "https://downscale.com.au",
      "https://api.abeai.health",  
      "http://api.abeai.health",   
      "http://localhost:3000",
      "https://downscaleweightloss.webflow.io"
    ];
    
    const origin = request.headers.get("Origin");
    const corsHeaders = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true"
    };
    
    if (origin && allowedOrigins.includes(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    } else if (origin) {
      console.log(`🚫 Unauthorized origin attempt: ${origin}`);
      return new Response("Unauthorized origin", { 
        status: 401, 
        headers: corsHeaders 
      });
    } else {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { 
        status: 204, 
        headers: corsHeaders 
      });
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { 
          status: 405, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (err) {
      console.log("Invalid JSON error:", err);
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    console.log("Request body:", JSON.stringify(body));

    let userMessage = body.message || body.prompt || "";
    const userId = body.user_id || null;
    
    if (userMessage.toLowerCase() === "welcome" || !userMessage) {
      const sessionId = userId || crypto.randomUUID();
      const welcomeResponse = {
        message: WELCOME_MESSAGE,
        sessionId: sessionId,
        pillar: "mental"
      };

      // Initialize new session data for welcome message
      const newSessionData = {
        messages: [{ role: "assistant", content: WELCOME_MESSAGE }],
        usage: 0,
        nutritionResponses: 0,
        tier: body.tier || "free",
        minor: false,
        offeredDiary: { clinical: false, nutrition: false, activity: false, mental: false },
        safetyInfo: null,
        awaitingSafetyInfo: false,
        pendingQuery: null,
        safetyInfoProvided: false,
        inSafetyFlow: false
      };

      try {
        await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(newSessionData));
      } catch (e) {
        console.log("KV Save Error during welcome:", e);
        return new Response(
          JSON.stringify({ error: "Failed to save session data" }),
          { 
            status: 500, 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
          }
        );
      }

      console.log(`🎉 Welcome message triggered, sessionId: ${sessionId}, usage: ${newSessionData.usage}, nutritionResponses: ${newSessionData.nutritionResponses}`);

      const headers = { ...corsHeaders, "Content-Type": "application/json" };
      headers["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;

      return new Response(
        JSON.stringify(welcomeResponse),
        { 
          status: 200, 
          headers 
        }
      );
    }
    
    if (typeof userMessage !== "string" || userMessage.trim() === "") {
      return new Response(
        JSON.stringify({ error: "No user message provided" }),
        { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }
    userMessage = userMessage.trim();

    // Correct Session Initialization
    let sessionId = userId || null;
    let newSession = false;

    if (!sessionId) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const sessionMatch = cookieHeader.match(/(?:^|;)\s*session_id=([^;]+)/);
      sessionId = sessionMatch ? sessionMatch[1] : crypto.randomUUID();
      newSession = !sessionMatch;
    }

    let sessionData;
    try {
      const kvKey = `session:${sessionId}`;
      const stored = await env["ABEAI_KV"].get(kvKey);
      sessionData = stored ? JSON.parse(stored) : null;
    } catch (e) {
      console.log("KV Load Error:", e);
      return new Response(
        JSON.stringify({ error: "Failed to load session data" }),
        { 
          status: 500, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    if (!sessionData) {
      sessionData = {
        messages: [],
        usage: 0,
        nutritionResponses: 0,
        tier: body.tier || "free",
        minor: false,
        offeredDiary: { clinical: false, nutrition: false, activity: false, mental: false },
        safetyInfo: null,
        awaitingSafetyInfo: false,
        pendingQuery: null,
        safetyInfoProvided: false,
        inSafetyFlow: false
      };
      newSession = true;
    }

    console.log(`Session loaded, sessionId: ${sessionId}, usage: ${sessionData.usage}, nutritionResponses: ${sessionData.nutritionResponses}, inSafetyFlow: ${sessionData.inSafetyFlow}`);

    const pillar = determinePillar(userMessage);
    
    // Safety question logic
    if (!sessionData.safetyInfo) {
      if (!sessionData.awaitingSafetyInfo) {
        sessionData.awaitingSafetyInfo = true;
        sessionData.pendingQuery = userMessage;
        sessionData.inSafetyFlow = true;
        
        let safetyPrompt = "Before we start, could you please inform me about:";
        if (pillar === "nutrition") {
          safetyPrompt += "\n✅ Any food allergies or intolerances?";
        } else if (pillar === "activity") {
          safetyPrompt += "\n✅ Injuries or physical limitations?";
        } else if (pillar === "clinical") {
          safetyPrompt += "\n✅ Medical conditions or medications?";
        }

        sessionData.messages.push({ role: "assistant", content: safetyPrompt });

        try {
          await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(sessionData));
        } catch (e) {
          console.log("KV Save Error during safety prompt:", e);
          return new Response(
            JSON.stringify({ error: "Failed to save session data" }),
            { 
              status: 500, 
              headers: { ...corsHeaders, "Content-Type": "application/json" } 
            }
          );
        }

        console.log(`Safety prompt sent, usage: ${sessionData.usage}, nutritionResponses: ${sessionData.nutritionResponses}`);

        const headers = { ...corsHeaders, "Content-Type": "application/json" };
        if (newSession) {
          headers["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
        }

        return new Response(
          JSON.stringify({ message: safetyPrompt, sessionId }),
          { status: 200, headers }
        );
      } else {
        sessionData.safetyInfo = parseSafetyInfo(userMessage);
        sessionData.awaitingSafetyInfo = false;
        sessionData.inSafetyFlow = false;

        const safeReply = generateSafeSuggestions(sessionData.safetyInfo, pillar);

        sessionData.messages.push({ role: "user", content: userMessage });
        sessionData.messages.push({ role: "assistant", content: safeReply });
        sessionData.safetyInfoProvided = true;

        try {
          await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(sessionData));
        } catch (e) {
          console.log("KV Save Error after safe suggestions:", e);
          return new Response(
            JSON.stringify({ error: "Failed to save session data" }),
            { 
              status: 500, 
              headers: { ...corsHeaders, "Content-Type": "application/json" } 
            }
          );
        }

        console.log(`Safe suggestions sent, usage: ${sessionData.usage}, nutritionResponses: ${sessionData.nutritionResponses}`);

        // Recall the original user query after safety check
        if (sessionData.pendingQuery) {
          userMessage = sessionData.pendingQuery;
          sessionData.pendingQuery = null;

          // Process the pending query
          const prompt = buildPrompt({
            message: userMessage,
            context: { 
              allergies: sessionData.safetyInfo.nutrition,
              injuries: sessionData.safetyInfo.activity,
              conditions: sessionData.safetyInfo.clinical 
            },
            history: sessionData.messages
          });
          
          try {
            const aiResponse = await handleAIRequest(prompt, env);
            sessionData.messages.push({ role: "assistant", content: aiResponse });
            await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(sessionData));

            return new Response(
              JSON.stringify({ message: aiResponse, sessionId }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          } catch (err) {
            console.log("AI request error:", err);
            return new Response(
              JSON.stringify({ error: "Failed to process AI request" }),
              { 
                status: 500, 
                headers: { ...corsHeaders, "Content-Type": "application/json" }
