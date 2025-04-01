// Parses raw user message into structured safety information
function parseSafetyInfo(userMessage) {
  const safetyInfo = { nutrition: "", activity: "", clinical: "" };
  const lowerMsg = userMessage.toLowerCase();

  if (lowerMsg === "no" || lowerMsg.trim() === "") {
    safetyInfo.nutrition = "None";
    safetyInfo.activity = "None";
    safetyInfo.clinical = "None";
    return safetyInfo;
  }

  const nutritionKeywords = ["nut", "dairy", "gluten", "shellfish", "soy", "egg", "fish"];
  const activityKeywords = ["injury", "knee", "back", "joint", "limitation", "pain"];
  const clinicalKeywords = ["medication", "medicine", "condition", "diabetes", "blood pressure"];

  nutritionKeywords.forEach(word => {
    if (lowerMsg.includes(word)) safetyInfo.nutrition += `${word}, `;
  });

  activityKeywords.forEach(word => {
    if (lowerMsg.includes(word)) safetyInfo.activity += `${word}, `;
  });

  clinicalKeywords.forEach(word => {
    if (lowerMsg.includes(word)) safetyInfo.clinical += `${word}, `;
  });

  Object.keys(safetyInfo).forEach(key => {
    safetyInfo[key] = safetyInfo[key].replace(/, $/, "") || "None";
  });

  return safetyInfo;
}

// Generates immediate safe suggestions explicitly avoiding reported risks
function generateSafeSuggestions(safetyInfo, pillar) {
  if (pillar === "nutrition" && safetyInfo.nutrition !== "None") {
    return `Thanks for sharing about your ${safetyInfo.nutrition} allergy/intolerance. Here are three safe snack ideas avoiding ${safetyInfo.nutrition}: 
1. Greek yogurt with fresh berries
2. Carrot sticks and hummus
3. Edamame beans
To get more personalized recipes, consider exploring our Premium subscription options.`;
  }

  if (pillar === "activity" && safetyInfo.activity !== "None") {
    return `Thank you for letting me know about your physical limitation (${safetyInfo.activity}). Here are three safe activities you might try:
1. Gentle yoga
2. Water-based exercises (swimming, aqua aerobics)
3. Seated resistance training
For more tailored exercise plans, you might find our Premium coaching helpful.`;
  }

  if (pillar === "clinical" && safetyInfo.clinical !== "None") {
    return `Thanks for informing me about your medical condition/medication (${safetyInfo.clinical}). I'll keep this in mind. Always consult your doctor before making significant changes.`;
  }

  return "Thanks for sharing! How else can I assist you today?";
}

// Helper to provide monetization options
function getMonetizationOptions(cf) {
  const options = [
    { name: "PAYG", description: "Flexible Pay-as-you-go", url: "https://downscaleai.com/payg" },
    { name: "Essentials", description: "Wellness Tracking", url: "https://downscaleai.com/essentials" },
    { name: "Premium", description: "Personalized Coaching", url: "https://downscaleai.com/premium" }
  ];

  if (cf && cf.country && cf.country.toUpperCase() === "AU") {
    options.push({
      name: "Clinical",
      description: "Medical Weight Management",
      url: "https://www.downscale.com.au"
    });
  }

  return options;
}

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
      const welcomeResponse = {
        message: WELCOME_MESSAGE,
        sessionId: userId || crypto.randomUUID(),
        pillar: "mental"
      };

      console.log(`🎉 Welcome message triggered`);

      return new Response(
        JSON.stringify(welcomeResponse),
        { 
          status: 200, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
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
        tier: body.tier || "free",
        minor: false,
        offeredDiary: { clinical: false, nutrition: false, activity: false, mental: false },
        safetyInfo: null,
        awaitingSafetyInfo: false,
        pendingQuery: null
      };
    }

    // Safety question logic
    if (!sessionData.safetyInfo) {
      if (!sessionData.awaitingSafetyInfo) {
        sessionData.awaitingSafetyInfo = true;
        sessionData.pendingQuery = userMessage;
        const safetyPrompt = `
Before we start, could you please inform me about:
✅ Any food allergies or intolerances?
✅ Injuries or physical limitations?
✅ Medical conditions or medications?
`;

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

        const acknowledgment = "Thank you! Let's proceed.";
        userMessage = sessionData.pendingQuery;
        sessionData.pendingQuery = null;

        sessionData.messages.push({ role: "assistant", content: acknowledgment });

        try {
          await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(sessionData));
        } catch (e) {
          console.log("KV Save Error after safety response:", e);
          return new Response(
            JSON.stringify({ error: "Failed to save session data" }),
            { 
              status: 500, 
              headers: { ...corsHeaders, "Content-Type": "application/json" } 
            }
          );
        }
      }
    }

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

    if (body.tier) {
      sessionData.tier = body.tier.toLowerCase();
    }
    
    const isPremium = [
      "premium", 
      "clinical", 
      "premium+clinical", 
      "essentials", 
      "payg"
    ].includes(sessionData.tier.toLowerCase());

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
      let safeResponse = "";
      if (hasSuicidalContent) {
        safeResponse = "I'm really sorry that you're feeling like this. It sounds like you are having thoughts of suicide or self-harm. **Please remember you are not alone and there are people who want to help you.** I strongly encourage you to reach out to a mental health professional or contact an emergency helpline immediately. In Australia, you can call **Lifeline at 13 11 14** or the **Suicide Call Back Service at 1300 659 467**. If you feel unsafe, please call **000** (Emergency Services). You might also talk to someone you trust, like a friend or family member, about what you're feeling. You do not have to go through this alone. <br/><br/>**Please reach out for help right away.**";
      } else if (hasEDContent) {
        safeResponse = "It sounds like you might be struggling with disordered eating or an eating disorder. I'm really sorry you're going through this. **Please know you are not alone and help is available.** I strongly encourage you to seek support from a healthcare professional, like a doctor or counselor, who specializes in eating disorders. In Australia, you can reach out to the **Butterfly Foundation** at **1800 ED HOPE (1800 33 4673)** for advice and support. If you feel it's an emergency or you're in crisis, call **000** or **Lifeline at 13 11 14**. You deserve help and support, and talking to a professional can make a big difference. <br/><br/>You're not alone, and there are people who care about you.";
      }
      
      sessionData.messages.push({ role: "user", content: userMessage });
      sessionData.messages.push({ role: "assistant", content: safeResponse });
      
      try {
        await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(sessionData));
      } catch (e) {
        console.log("Error saving session data:", e);
        return new Response(
          JSON.stringify({ error: "Failed to save session data" }),
          { 
            status: 500, 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
          }
        );
      }
      
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

    const FREE_RESPONSE_LIMIT = 3;
    const shouldMonetize = !isPremium && sessionData.usage >= FREE_RESPONSE_LIMIT;

    let pillar = "mental";
    const clinicalKeywords = ["doctor", "medication", "GLP", "medicine", "prescription", "clinic", "treatment", "diagnosis", "side effect"];
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
      const upsellMessage = `You've reached your free query limit for the ${pillar} area. Please explore subscription options for continued personalized support.`;
      const upgradeOptions = getMonetizationOptions(request.cf);

      const headers = { ...corsHeaders, "Content-Type": "application/json" };
      if (newSession) {
        headers["Set-Cookie"] = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`;
      }

      sessionData.messages.push({ role: "assistant", content: upsellMessage });

      try {
        await env["ABEAI_KV"].put(`session:${sessionId}`, JSON.stringify(sessionData));
      } catch (e) {
        console.log("KV Save Error during monetization:", e);
        return new Response(
          JSON.stringify({ error: "Failed to save session data" }),
          { 
            status: 500, 
            headers: { ...corsHeaders, "Content-Type": "application/json" } 
          }
        );
      }

      return new Response(JSON.stringify({
        message: upsellMessage,
        monetize: true,
        sessionId,
        pillar,
        upgradeOptions
      }), { status: 200, headers });
    }

    let systemContent = "You are Abe, an AI health coach assisting users with weight loss and well-being across clinical, nutrition, activity, and mindset topics. Always respond with a friendly, empathetic tone and provide helpful, evidence-based advice.\n\n";
    
    if (pillar === "clinical") {
      systemContent += "The user's question is related to clinical/medical advice. Provide general medical information regarding weight management or health, but do **not** give definitive medical diagnoses or prescriptions. Encourage consulting a doctor for any serious medical issues or before making major health changes. ";
    } else if (pillar === "nutrition") {
      systemContent += "The user's question is about nutrition or diet. Provide guidance on healthy eating, meal planning, and nutrition in a supportive, non-judgmental way. Emphasize balanced, sustainable dietary habits rather than quick fixes. ";
    } else if (pillar === "activity") {
      systemContent += "The user's question is about physical activity or exercise. Provide advice on exercise routines, fitness, and staying active, tailored to the user's level. Emphasize consistency, safety, and finding enjoyable ways to be active. ";
    } else if (pillar === "mental") {
      systemContent += "The user's question relates to mindset or mental well-being. Provide support on motivation, stress management, sleep, or emotional health as it pertains to their weight loss journey. Be encouraging and understanding, promoting healthy coping strategies. ";
    }
    
    if (sessionData.minor) {
      systemContent += "The user is a minor (under
