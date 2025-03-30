export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    let requestData;
    try {
      requestData = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const userId = requestData.userId || "anonymous";  // default if not provided
    const userMessage = (requestData.message || "").trim();
    if (!userMessage) {
      return new Response(JSON.stringify({
        response: "Hello! How can I help you on your health journey today?",
        buttons: [],
        upgradeSuggested: false
      }), { headers: { "Content-Type": "application/json" } });
    }

    const kvKey = `user:${userId}`;
    // Load or initialize user context from KV
    let userData = await env.ABEAI_KV.get(kvKey, { type: "json" });
    if (!userData) {
      userData = {
        tier: "free",
        responseCount: 0,
        safety: { clinical: null, nutrition: null, activity: null, mental: null },
        pendingSafety: null,
        pendingQuestion: null,
        isClinicPatient: false
      };
    }

    // If a safety question was previously asked and awaiting an answer
    if (userData.pendingSafety) {
      const pillar = userData.pendingSafety;
      // Save the user's answer in the appropriate safety context
      const answer = userMessage;
      if (answer.toLowerCase().includes("no") && (pillar === "clinical" || pillar === "nutrition" || pillar === "activity" || pillar === "mental")) {
        // If the answer indicates "no" or none, store a meaningful value
        userData.safety[pillar] = "None";
      } else {
        userData.safety[pillar] = answer;  // store the raw answer for context
      }
      userData.pendingSafety = null;
      // The original question that was pending
      if (userData.pendingQuestion) {
        // Restore the original question as the userMessage to be answered
        var originalQuestion = userData.pendingQuestion;
        userData.pendingQuestion = null;
      }
      // Save updated context (so we don't ask the same safety again and to have context for answer)
      await env.ABEAI_KV.put(kvKey, JSON.stringify(userData));
      // If there was an original question to answer, proceed with that (fall through to normal flow with originalQuestion as the message).
      if (originalQuestion) {
        // Replace userMessage with the original question for further processing
        requestData.message = originalQuestion;
      }
    }

    // Re-check userMessage in case we replaced it with pending original question
    const messageToProcess = requestData.message || userMessage;

    // Detect active pillar(s) from the message
    const msgLower = messageToProcess.toLowerCase();
    const triggeredPillars = [];
    if (/\b(bmi|medication|insulin|thyroid|bariatric|metabolism)\b/.test(msgLower)) {
      triggeredPillars.push("clinical");
    }
    if (/\b(snack|calorie|carb|protein|diet|meal|fasting)\b/.test(msgLower)) {
      triggeredPillars.push("nutrition");
    }
    if (/\b(steps|yoga|running|joint pain|injury|injuries|exercise|fitness)\b/.test(msgLower)) {
      triggeredPillars.push("activity");
    }
    if (/\b(stress|sleep|anxiety|depression|motivation|binge|emotional)\b/.test(msgLower)) {
      triggeredPillars.push("mental");
    }

    // If we have an originalQuestion in context (from multiple safety prompts scenario)
    // and still missing context for another pillar, handle next safety.
    // Find the first pillar that is triggered and not yet addressed (null in safety context)
    let safetyPillarNeeded = null;
    for (let pillar of ["clinical", "nutrition", "activity", "mental"]) {
      if (triggeredPillars.includes(pillar) && (userData.safety[pillar] === null)) {
        safetyPillarNeeded = pillar;
        break;
      }
    }
    if (safetyPillarNeeded) {
      // We need to ask a safety question for this pillar
      let safetyPrompt = "";
      switch (safetyPillarNeeded) {
        case "clinical":
          safetyPrompt = "Are you currently taking any medications or managing medical conditions?";
          break;
        case "nutrition":
          safetyPrompt = "Do you have any allergies or intolerances (e.g., dairy, gluten, nuts)?";
          break;
        case "activity":
          safetyPrompt = "Any injuries or joint concerns that affect your movement or exercise?";
          break;
        case "mental":
          safetyPrompt = "Are you currently receiving support for stress, anxiety, or mental health?";
          break;
      }
      // Store that we're waiting for this safety answer and save the user's original question if not already saved
      userData.pendingSafety = safetyPillarNeeded;
      if (!userData.pendingQuestion) {
        userData.pendingQuestion = messageToProcess;
      }
      // Save state to KV
      await env.ABEAI_KV.put(kvKey, JSON.stringify(userData));
      // Return the safety prompt response (no AI call yet)
      return new Response(JSON.stringify({
        response: safetyPrompt,
        buttons: [],
        upgradeSuggested: false
      }), { headers: { "Content-Type": "application/json" } });
    }

    // At this point, we have all needed safety context for the message, or none was needed.
    // Check for upsell condition: free tier user exceeding free response count
    if (userData.tier === "free" && userData.responseCount >= 3) {
      // Construct an upsell response with contextual message
      let tip = "";
      if (triggeredPillars.includes("clinical")) {
        tip = "For medical weight management, consider a specialized approach.";
      } else if (triggeredPillars.includes("nutrition")) {
        tip = "Balanced meals with plenty of protein and fibre are a great foundation.";
      } else if (triggeredPillars.includes("activity")) {
        tip = "Even a short walk or gentle stretching can help you stay active.";
      } else if (triggeredPillars.includes("mental")) {
        tip = "Taking care of your mental wellbeing is just as important as physical health.";
      }
      if (tip) tip += " "; 
      // Base upsell text
      let upsellText = `${tip}You've reached the limit of free responses. For more personalized guidance and unlimited support, consider upgrading your plan.`;
      // Prepare upgrade buttons
      const buttons = [
        { text: "PAYG Plan", url: "https://downscaleai.com/payg" },
        { text: "Essentials Plan", url: "https://downscaleai.com/essentials" },
        { text: "Premium Plan", url: "https://downscaleai.com/premium" },
        { text: "Clinical Plan", url: "https://downscaleai.com/clinical" }
      ];
      // Include clinic booking for Australian users (if not already on Clinical tier)
      try {
        if (request.cf && request.cf.country === "AU" && userData.tier !== "Clinical") {
          buttons.push({ text: "Book with Downscale Clinic", url: "https://www.downscale.com.au" });
        }
      } catch(e) {
        // if request.cf is not available for some reason, just skip adding clinic button
      }
      return new Response(JSON.stringify({
        response: upsellText,
        buttons: buttons,
        upgradeSuggested: true
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Otherwise, we proceed to generate an AI answer using OpenAI.
    // Compose the system prompt for OpenAI with all personalization:
    const systemInstructions = [];
    // Role and persona
    systemInstructions.push("You are Abe, a compassionate AI assistant for weight management.");
    // Australian English and culture
    systemInstructions.push("Use Australian English spelling and vocabulary (e.g., colour, metre) and casual Australian cultural references where suitable (like mentioning Vegemite or footy) to make the advice relatable.");
    // Empathy and stigma-free language
    systemInstructions.push("Maintain an empathetic, motivational tone. Provide advice in a safe, non-judgmental manner, avoiding any stigma or blame [oai_citation_attribution:8‡medscape.com](https://www.medscape.com/viewarticle/empathy-please-be-sensitive-addressing-weight-management-2025a10002cs#:~:text=There%20was%20a%20time%20not,in%20Chapel%20Hill%2C%20North%20Carolina).");
    // Maslow’s hierarchy alignment (address emotional and practical needs)
    systemInstructions.push("Support the user's emotional needs as well as practical needs – be encouraging and positive, reinforcing their esteem and self-care.");
    // Tier-based detail
    if (userData.tier === "free" || userData.tier === "PAYG") {
      systemInstructions.push("Keep responses concise and to the point.");
    } else if (userData.tier === "Essentials") {
      systemInstructions.push("Provide a moderate level of detail in your response.");
    } else if (userData.tier === "Premium" || userData.tier === "Clinical") {
      systemInstructions.push("Offer a thorough, in-depth response with as much context and detail as needed.");
    }
    // Include known user context from safety info
    const contextNotes = [];
    if (userData.safety.clinical) {
      contextNotes.push(`Medical: ${userData.safety.clinical}`);
    }
    if (userData.safety.nutrition) {
      contextNotes.push(`Dietary: ${userData.safety.nutrition}`);
    }
    if (userData.safety.activity) {
      contextNotes.push(`Injuries: ${userData.safety.activity}`);
    }
    if (userData.safety.mental) {
      contextNotes.push(`Mental Health: ${userData.safety.mental}`);
    }
    if (contextNotes.length > 0) {
      systemInstructions.push("Take into account the user's context: " + contextNotes.join("; ") + ".");
    }
    // Diary prompt instruction
    systemInstructions.push("Always end your answer with a friendly question encouraging the user to log or track something (a meal, mood, activity, hydration, etc.) in their diary, as appropriate to the conversation. Premium users have an intimacy journal feature as well.");
    const systemPrompt = systemInstructions.join(" ");

    // Prepare messages for OpenAI API
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: messageToProcess }
    ];

    // Choose model and parameters
    const model = env.OPENAI_MODEL || "gpt-3.5-turbo";  // Model can be configured via env
    const maxTokens = (userData.tier === "Premium" || userData.tier === "Clinical") ? 500
                    : (userData.tier === "Essentials") ? 300
                    : 150;  // Free/PAYG default to shorter answers
    const payload = {
      model: model,
      messages: messages,
      max_tokens: maxTokens,
      temperature: 0.7
    };

    // Call OpenAI via Cloudflare AI Gateway
    const openaiUrl = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/openai/chat/completions`;
    let aiResponse;
    try {
      aiResponse = await fetch(openaiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      // Network or fetch error when contacting OpenAI
      const fallback = generateFallback(triggeredPillars);
      return new Response(JSON.stringify({
        response: fallback,
        buttons: [],
        upgradeSuggested: false
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (!aiResponse.ok) {
      // API returned an error (e.g., 400 or 500 status)
      const fallback = generateFallback(triggeredPillars);
      return new Response(JSON.stringify({
        response: fallback,
        buttons: [],
        upgradeSuggested: false
      }), { headers: { "Content-Type": "application/json" } });
    }

    const completion = await aiResponse.json();
    let aiMessage = "";
    try {
      aiMessage = completion.choices[0].message.content;
    } catch {
      // If parsing fails or no content
      const fallback = generateFallback(triggeredPillars);
      return new Response(JSON.stringify({
        response: fallback,
        buttons: [],
        upgradeSuggested: false
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Update response count for free users
    if (userData.tier === "free") {
      userData.responseCount = (userData.responseCount || 0) + 1;
    }
    // Save any updates (e.g., incremented count) back to KV
    await env.ABEAI_KV.put(kvKey, JSON.stringify(userData));

    // Typically, normal answers have no extra buttons and upgradeSuggested is false (unless logic above changed it)
    const result = {
      response: aiMessage,
      buttons: [],
      upgradeSuggested: false
    };
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }
};

// Helper function to choose a fallback message based on pillars
function generateFallback(triggeredPillars) {
  let pillar = triggeredPillars.length ? triggeredPillars[0] : null;
  switch (pillar) {
    case "clinical":
      return "Sorry, I couldn't process that right now. For medical weight guidance, you might consider our Clinical plan.";
    case "nutrition":
      return "I’m having trouble responding at the moment, but remember: balanced meals with protein and fibre are always a good idea.";
    case "activity":
      return "Sorry, I can't give advice right now. Even a short walk or stretch can be helpful in the meantime to stay active.";
    case "mental":
      return "Apologies, I couldn't respond just now. Try taking a deep breath and we'll chat more about this soon.";
    default:
      return "Sorry, I'm unable to respond right now. Let's try again in a bit.";
  }
}
