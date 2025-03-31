export default {
  async fetch(request, env, ctx) {
    // Enhanced Welcome Message
    const WELCOME_MESSAGE = `Hi, I'm AbeAI, your personalised health companion. 

I'm here to support your wellness journey across four key areas:
🩺 Clinical Health
🥗 Nutrition Guidance
🏋️ Activity & Fitness
🧠 Mental Wellbeing

What area would you like to explore today? Whether you're looking to understand your health metrics, plan nutritious meals, find enjoyable ways to stay active, or boost your mental resilience – I'm here to help, without judgment.



    // Define allowed origins for CORS (update with your actual Webflow domain)
    const allowedOrigins = [
      "https://www.abeai.health",
      "https://abeai.health",
      "https://www.downscale.com.au",
      "https://downscale.com.au",
      "https://api.abeai.health",  
      "http://api.abeai.health",   
      "http://localhost:3000",
      // Add your Webflow domain here if not already included
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
      // If origin is not in the list, you can log this for debugging
      console.log(`🚫 Unauthorized origin attempt: ${origin}`);
      return new Response("Unauthorized origin", { status: 401 });
    } else {
      // No Origin (e.g., server-to-server request)
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    }

    // Handle CORS preflight request
    if (request.method === "OPTIONS") {
      return new Response(null, { 
        status: 204, 
        headers: corsHeaders 
      });
    }

    // Only allow POST for main requests
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { 
          status: 405, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    // Parse request body as JSON
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

    // Log request for debugging (remove in production)
    console.log("Request body:", JSON.stringify(body));

    // Check if we're receiving a message from the Webflow chatbot
    // Adapt this based on your actual frontend implementation
    let userMessage = body.message || body.prompt || "";
    const userId = body.user_id || null;
    
    // Special Handling for Welcome Message
    if (userMessage.toLowerCase() === "welcome" || !userMessage) {
      const welcomeResponse = {
        message: WELCOME_MESSAGE,
        sessionId: userId || crypto.randomUUID(),
        pillar: "mental"
      };

      console.log(`🎉 Welcome message triggered`);

      return new Response(
        JSON.stringify(welcomeResponse),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

    // Session handling - use user_id from request if provided
    let sessionId = userId || null;
    let newSession = false;
    
    // If no userId was provided in the request but we have a cookie, use that
    if (!sessionId) {
      const cookieHeader = request.headers.get("Cookie") || "";
      const sessionMatch = cookieHeader.match(/(?:^|;)\s*session_id=([^;]+)/);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
      }
    }
    
    // If still no sessionId, create a new one
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      newSession = true;
    }

    // Load existing session data from KV or initialize a new session object
    let sessionData;
    
    try {
      if (!newSession) {
        const kvKey = `session:${sessionId}`;
        const stored = await env["abeai-kv"].get(kvKey);
        if (stored) {
          sessionData = JSON.parse(stored);
          console.log(`🔍 Loaded session data for ${sessionId}`);
        } else {
          console.log(`📝 No existing session found for ID: ${sessionId}`);
        }
      }
    } catch (e) {
      console.log("Error loading session data:", e);
      // If there's an error accessing KV, continue with a new session
    }
    
    // Initialize new session if needed
    if (!sessionData) {
      sessionData = {
        messages: [],
        usage: 0,
        tier: body.tier || "free",
        minor: false,
        offeredDiary: { clinical: false, nutrition: false, activity: false, mental: false }
      };
      console.log("📦 Created new session data");
    }

    // Update age/minor status if provided in request
    if (body.age !== undefined || body.userAge !== undefined) {
      const ageVal = body.age !== undefined ? body.age : body.userAge;
      let ageNum = ageVal;
      if (typeof ageVal === "string") {
        ageNum = parseInt(ageVal, 10);
      }
      if (typeof ageNum === "number" && !isNaN(ageNum)) {
        sessionData.minor = ageNum < 18;
      }
    }

    // Update tier if provided
    if (body.tier) {
      sessionData.tier = body.tier.toLowerCase();
    }
    
    // Determine premium status with expanded tier recognition
    const isPremium = [
      "premium", 
      "clinical", 
      "premium+clinical", 
      "essentials", 
      "payg"
    ].includes(sessionData.tier.toLowerCase());

    // Check for safety triggers in the user message
    const lowerMsg = userMessage.toLowerCase();
    const suicideTriggers = [
      "kill myself", "want to die", "suicide", "end my life", 
      "take my life", "no reason to live", "don't want to live"
    ];
    const edTriggers = [
      "eating disorder", "anorexia", "anorexic", "bulimia", "bulimic",
      "starve", "starving", "stop eating", "don't eat", "vomit", "purging", "throw up"
    ];
    
    const hasSuicidalContent = suicideTriggers.some(phrase => lowerMsg.includes(phrase));
    const hasEDContent = !hasSuicidalContent && edTriggers.some(phrase => lowerMsg.includes(phrase));
    
    if (hasSuicidalContent || hasEDContent) {
      // Safety override - don't call the AI
      let safeResponse = "";
      if (hasSuicidalContent) {
        safeResponse = "I'm really sorry that you're feeling like this. It sounds like you are having thoughts of suicide or self-harm. **Please remember you are not alone and there are people who want to help you.** I strongly encourage you to reach out to a mental health professional or contact an emergency helpline immediately. In Australia, you can call **Lifeline at 13&nbsp;11&nbsp;14** or the **Suicide Call Back Service at 1300&nbsp;659&nbsp;467**. If you feel unsafe, please call **000** (Emergency Services). You might also talk to someone you trust, like a friend or family member, about what you're feeling. You do not have to go through this alone. <br/><br/>**Please reach out for help right away.**";
      } else if (hasEDContent) {
        safeResponse = "It sounds like you might be struggling with disordered eating or an eating disorder. I'm really sorry you're going through this. **Please know you are not alone and help is available.** I strongly encourage you to seek support from a healthcare professional, like a doctor or counselor, who specializes in eating disorders. In Australia, you can reach out to the **Butterfly Foundation** at **1800&nbsp;ED&nbsp;HOPE (1800&nbsp;33&nbsp;4673)** for advice and support. If you feel it's an emergency or you're in crisis, call **000** or **Lifeline at 13&nbsp;11&nbsp;14**. You deserve help and support, and talking to a professional can make a big difference. <br/><br/>You're not alone, and there are people who care about you.";
      }
      
      // Record the conversation
      sessionData.messages.push({ role: "user", content: userMessage });
      sessionData.messages.push({ role: "assistant", content: safeResponse });
      
      // Save session state to KV
      try {
        await env["abeai-kv"].put(`session:${sessionId}`, JSON.stringify(sessionData));
      } catch (e) {
        console.log("Error saving session data:", e);
      }
      
      // Return the safe response
      const headers = { ...corsHeaders, "Content-Type": "application/json" };
      if (newSession) {
        headers["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
      }
      
      return new Response(
        JSON.stringify({ 
          message: safeResponse,
          sessionId: sessionId
        }),
        { status: 200, headers }
      );
    }

    // Check for monetization triggers based on usage and tier
    const FREE_RESPONSE_LIMIT = 3; // Aligned with business plan
    
    // Check if we should monetize based on usage limit
    const shouldMonetize = !isPremium && sessionData.usage >= FREE_RESPONSE_LIMIT;
    
    // Additional monetization logic based on pillar detection
    let pillar = "mental";
    const clinicalKeywords = ["doctor", "medication", "medicine", "prescription", "clinic", "treatment", "diagnosis", "side effect"];
    const nutritionKeywords = ["diet", "calorie", "calories", "protein", "carb", "fat ", "meal", "nutrition", "eat ", "eating", "food", "recipe", "hydration"];
    const activityKeywords = ["exercise", "workout", "work out", "gym", "sport", "training", "run", "running", "walk", "walking", "yoga", "activity", "active", "steps"];
    const mentalKeywords = ["motivation", "stress", "anxiety", "depression", "mood", "sleep", "mindset", "mental", "therapy", "habit", "feel", "feeling"];
    
    if (clinicalKeywords.some(w => lowerMsg.includes(w))) {
      pillar = "clinical";
    } else if (nutritionKeywords.some(w => lowerMsg.includes(w))) {
      pillar = "nutrition";
    } else if (activityKeywords.some(w => lowerMsg.includes(w))) {
      pillar = "activity";
    } else if (mentalKeywords.some(w => lowerMsg.includes(w))) {
      pillar = "mental";
    }
    
    if (shouldMonetize) {
      // User has reached free limit - provide upsell message
      const upsellMessage = `You've reached the limit of free queries in the ${pillar} domain. To continue getting personalized advice and unlock all features, please explore our subscription options.`;
      
      // Prepare upgrade options
      const upgradeOptions = [
        { 
          name: "PAYG", 
          description: "Pay-as-you-go flexible support", 
          url: "https://downscaleai.com/payg" 
        },
        { 
          name: "Essentials", 
          description: "Comprehensive wellness tracking", 
          url: "https://downscaleai.com/essentials" 
        },
        { 
          name: "Premium", 
          description: "Advanced personalized coaching", 
          url: "https://downscaleai.com/premium" 
        }
      ];

      // Add Australian Clinical option if user is in Australia
      if (request.cf && request.cf.country && request.cf.country.toUpperCase() === "AU") {
        upgradeOptions.push({
          name: "Clinical", 
          description: "Medical-grade weight management", 
          url: "https://www.downscale.com.au"
        });
      }
      
      // Log interaction
      sessionData.messages.push({ role: "user", content: userMessage });
      sessionData.messages.push({ role: "assistant", content: upsellMessage });
      
      // Save session
      try {
        await env["abeai-kv"].put(`session:${sessionId}`, JSON.stringify(sessionData));
      } catch (e) {
        console.log("Error saving session after monetization:", e);
      }
      
      // Return the upsell response
      const headers = { ...corsHeaders, "Content-Type": "application/json" };
      if (newSession) {
        headers["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
      }
      
      return new Response(
        JSON.stringify({ 
          message: upsellMessage,
          sessionId: sessionId,
          monetize: true,
          pillar: pillar,
          upgradeOptions: upgradeOptions
        }),
        { status: 200, headers }
      );
    }

    // Build the system message with context and guidelines
    let systemContent = "You are Abe, an AI health coach assisting users with weight loss and well-being across clinical, nutrition, activity, and mindset topics. Always respond with a friendly, empathetic tone and provide helpful, evidence-based advice.\n\n";
    
    // Add pillar-specific context
    if (pillar === "clinical") {
      systemContent += "The user's question is related to clinical/medical advice. Provide general medical information regarding weight management or health, but do **not** give definitive medical diagnoses or prescriptions. Encourage consulting a doctor for any serious medical issues or before making major health changes. ";
    } else if (pillar === "nutrition") {
      systemContent += "The user's question is about nutrition or diet. Provide guidance on healthy eating, meal planning, and nutrition in a supportive, non-judgmental way. Emphasize balanced, sustainable dietary habits rather than quick fixes. ";
    } else if (pillar === "activity") {
      systemContent += "The user's question is about physical activity or exercise. Provide advice on exercise routines, fitness, and staying active, tailored to the user's level. Emphasize consistency, safety, and finding enjoyable ways to be active. ";
    } else if (pillar === "mental") {
      systemContent += "The user's question relates to mindset or mental well-being. Provide support on motivation, stress management, sleep, or emotional health as it pertains to their weight loss journey. Be encouraging and understanding, promoting healthy coping strategies. ";
    }
    
    // Age filtering context if minor
    if (sessionData.minor) {
      systemContent += "The user is a minor (under 18), so ensure all advice is appropriate for someone younger. Avoid recommendations not suitable for adolescents (like certain supplements or extreme diets) and encourage involving a parent/guardian or a doctor when necessary. ";
    }
    
    // Localization for Australian users
    if (request.cf && request.cf.country && request.cf.country.toUpperCase() === "AU") {
      systemContent += "Use Australian English spelling and examples relevant to Australia when appropriate (for instance, use \"kilograms\" and \"kilojoules\" for weight and energy, and terms like \"Mum\" instead of \"Mom\"). ";
    }
    
    // General safety and diary logging instruction
    systemContent += "Never encourage unsafe or unhealthy behaviors (like self-harm, starvation, or dangerous weight loss tactics). If the user seems to be in crisis or asking for harmful advice, respond with care and encourage seeking professional help. Also, when it fits naturally, remind the user about keeping a health diary or log (for example, a food diary, exercise log, or mood journal) to track their progress. Do not force the topic, but gently suggest it if it would help. ";
    systemContent += "\nNow, answer the user's question helpfully.";

    // Assemble the OpenAI chat messages array
    const openaiMessages = [];
    openaiMessages.push({ role: "system", content: systemContent });
    
    // Include conversation history for context
    for (const msg of sessionData.messages) {
      openaiMessages.push(msg);
    }
    
    // Add the latest user message
    openaiMessages.push({ role: "user", content: userMessage });

    // Prepare the OpenAI API request
    const model = isPremium ? "gpt-4" : "gpt-3.5-turbo";
    const payload = {
      model: model,
      messages: openaiMessages,
      temperature: 0.7,
      max_tokens: isPremium ? 2000 : 1000
    };
    
    // CORRECT: Use the proper base gateway URL
    const gatewayBaseUrl = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai";
    
    // CORRECT: Append the specific endpoint path to the base URL
    const apiUrl = `${gatewayBaseUrl}/v1/chat/completions`;
    
    // Log the full URL being used
    console.log("Using API URL:", apiUrl);
    
    // Headers for Cloudflare AI Gateway
    const apiHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_KEY}`
    };

    // Execute the API call with retry logic
    let aiResponse;
    let aiResult;
    const maxRetries = 3;
    let waitTime = 500;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Attempt ${attempt} to call OpenAI API via AI Gateway`);
        aiResponse = await fetch(apiUrl, {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify(payload)
        });
      } catch (err) {
        console.log(`API call error (attempt ${attempt}):`, err);
        aiResponse = null;
      }
      
      if (aiResponse && aiResponse.ok) {
        // Successful response
        try {
          aiResult = await aiResponse.json();
          break;
        } catch (e) {
          console.log("Failed to parse AI response:", e);
          return new Response(
            JSON.stringify({ error: "Failed to parse AI response" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } else if (aiResponse && (aiResponse.status === 429 || aiResponse.status === 503 || aiResponse.status === 524)) {
        // Rate limited or service unavailable - retry
        if (attempt < maxRetries) {
          console.log(`Retrying after status ${aiResponse.status}`);
          await new Promise(res => setTimeout(res, waitTime));
          waitTime *= 2;
          continue;
        } else {
          // Max retries reached
          let errorMsg = `AI service error (status ${aiResponse.status})`;
          try {
            const errorData = await aiResponse.json();
            if (errorData.error && errorData.error.message) {
              errorMsg = errorData.error.message;
            }
          } catch (_) { /* ignore parse errors for error body */ }
          
          console.log("Final error after retries:", errorMsg);
          return new Response(
            JSON.stringify({ error: errorMsg }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } else {
        // Other error
        if (attempt < maxRetries) {
          console.log(`Retrying after unknown error (attempt ${attempt})`);
          await new Promise(res => setTimeout(res, waitTime));
          waitTime *= 2;
          continue;
        } else {
          const statusCode = aiResponse ? aiResponse.status : 500;
          console.log(`Failed all retries, status: ${statusCode}`);
          return new Response(
            JSON.stringify({ error: "Failed to retrieve a response from the AI service." }),
            { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // Ensure we have the AI result
    if (!aiResult) {
      console.log("No AI result received");
      return new Response(
        JSON.stringify({ error: "No response from AI service" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract the assistant's reply
    let assistantMessage = "";
    if (aiResult.choices && aiResult.choices.length > 0 && aiResult.choices[0].message) {
      assistantMessage = aiResult.choices[0].message.content ?? "";
    }
    
    if (!assistantMessage) {
      console.log("AI returned empty message");
      return new Response(
        JSON.stringify({ error: "AI returned an empty message" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if this is message 3-5 and should trigger monetization for free users
    const shouldAddMonetizationHint = !isPremium && sessionData.usage >= 2 && sessionData.usage <= 4;
    
    // Add diary/logging prompt if not already mentioned
    if (!sessionData.offeredDiary[pillar]) {
      const answerLower = assistantMessage.toLowerCase();
      if (!answerLower.includes("diary") && !answerLower.includes("journal") && !answerLower.includes("log ")) {
        let diaryPrompt = "";
        if (pillar === "clinical") {
          diaryPrompt = " You might also consider keeping a health journal – for example, jot down your symptoms or medical readings daily. This can help you and your doctor track progress over time.";
        } else if (pillar === "nutrition") {
          diaryPrompt = " It could be helpful to keep a food diary. Tracking what you eat and drink each day can give you insight into your habits and help you stay accountable.";
        } else if (pillar === "activity") {
          diaryPrompt = " Consider maintaining an exercise log. Writing down your daily activities or workouts, and how you feel after, can be motivating and help you see improvements over time.";
        } else if (pillar === "mental") {
          diaryPrompt = " You might try keeping a journal for your thoughts or moods. Sometimes writing down how you feel each day can help manage stress and track your emotional well-being.";
        }
        if (diaryPrompt) {
          assistantMessage += diaryPrompt;
        }
      }
      sessionData.offeredDiary[pillar] = true;
    }
    
    // Add monetization hint if appropriate
    if (shouldAddMonetizationHint) {
      assistantMessage += "\n\n*Looking for more personalized guidance? Consider upgrading to our Premium plan for tailored advice and unlimited conversations.*";
    }

    // Update session conversation history and usage count
    sessionData.messages.push({ role: "user", content: userMessage });
    sessionData.messages.push({ role: "assistant", content: assistantMessage });
    sessionData.usage += 1;

    // Save the updated session data to KV
    try {
      await env["abeai-kv"].put(`session:${sessionId}`, JSON.stringify(sessionData));
    } catch (e) {
      console.log("Error saving final session data:", e);
    }

    // CORRECTED FINAL RESPONSE: Changed 'content' to 'message' to match frontend expectations
    const responseBody = {
      message: assistantMessage,  // Changed from 'content' to 'message'
      sessionId: sessionId,
      usage: sessionData.usage,
      pillar: pillar,
      tier: sessionData.tier
    };
    
    // Set headers and return
    const responseHeaders = { ...corsHeaders, "Content-Type": "application/json" };
    if (newSession) {
      responseHeaders["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
    }
    
    return new Response(
      JSON.stringify(responseBody), 
      { status: 200, headers: responseHeaders }
    );
  }
}
