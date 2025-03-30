// Comprehensive AbeAI Backend Script for Cloudflare Worker (Using Cloudflare KV: abeai-kv)
export default {
  async fetch(request, env, ctx) {
    try {
      // 1. Parse the incoming request JSON
      const data = await request.json();
      const userMessage = (data?.message || "").trim();
      let userId = "";
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        userId = authHeader.substring(7);
      }
      if (!userId) {
        userId = request.headers.get("cf-connecting-ip") || "anonymous";
      }
      const userKey = `user:${userId}`;

      // 2. Retrieve user context from Cloudflare KV (abeai-kv)
      let context = await env.USER_KV.get(userKey, { type: "json" });
      if (!context) {
        context = { 
          tier: "free", 
          responses: 0, 
          safety: {}, 
          history: [], 
          awaitingSafety: null, 
          isAustralian: request.cf && request.cf.country === "AU" 
        };
      }

      // Helper function: Update context in Cloudflare KV
      const saveContext = async () => {
        await env.USER_KV.put(userKey, JSON.stringify(context));
      };

      // 3. Safety-First Checks
      const messageLower = userMessage.toLowerCase();

      // Self-harm / suicidal ideation check
      const suicideIndicators = ["suicide", "kill myself", "end my life", "die by suicide", "want to die"];
      if (suicideIndicators.some(ind => messageLower.includes(ind))) {
        const safeResponse = 
          "I'm really sorry that you're feeling like this. 😔 You might consider reaching out to a mental health professional or someone you trust for help. " + 
          "In Australia, you can call **Lifeline at 13 11 14** anytime to talk to someone who cares. You **are not alone**, and there are people who want to help you. " + 
          "Please remember you are important and deserving of support.💕";
        return new Response(JSON.stringify({
          response: safeResponse,
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Minor check
      const minorSelfRegex = /\b(i\s*am|i'm)\s*(\d{1,2})\s*(years?\s*old|y\/?o)\b/;
      const minorMatch = messageLower.match(minorSelfRegex);
      if (minorMatch) {
        const age = parseInt(minorMatch[2], 10);
        if (age && age < 18) {
          const minorResponse = 
            "Thank you for your message. It sounds like you might be under 18. I'm really sorry, but I can’t continue with advice. 🙏 " +
            "Weight guidance for minors should involve a parent or healthcare professional. Please talk to a trusted adult or your doctor about your goals. " + 
            "They will help you find a safe and healthy path forward. Take care!";
          return new Response(JSON.stringify({
            response: minorResponse,
            buttons: [],
            upgradeSuggested: false
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
      }

      // Disordered eating check
      const disorderedIndicators = ["vomit", "vomiting", "throw up", "purge", "laxative", "starve", "starving", "not eat anything", "only water fast", "self-harm"];
      if (disorderedIndicators.some(ind => messageLower.includes(ind))) {
        const edResponse = 
          "I’m sorry, but I cannot assist with that request. That approach is very **unsafe** for your health. 🙅‍♀️ " +
          "Instead, it's important to seek help: consider reaching out to a doctor or mental health professional. " +
          "Healthy weight loss should never involve harming yourself or your body. 💜 Let's focus on **safe, sustainable methods** – you deserve to be healthy and safe.";
        return new Response(JSON.stringify({
          response: edResponse,
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // 4. Determine the pillar
      let pillar = "general";
      const keywords = {
        clinical: ["doctor", "gp", "medicat", "prescript", "surgery", "clinic", "pharmacy", "blood pressure", "diabetes", "thyroid", "diagnosed", "pill", "injection", "insulin", "bariatric", "metabolism", "weight loss", "plateau"],
        mental: ["mind", "mental", "motivati", "stress", "depress", "anxiety", "mindset", "mood", "sleep", "tired", "burnout", "overwhelm", "feelings", "emotional", "binge", "self-esteem"],
        nutrition: ["diet", "calorie", "protein", "carb", "fat intake", "meal", "food", "eat", "nutrition", "snack", "breakfast", "lunch", "dinner", "vegetable", "fruit", "cook", "sugar", "recipe", "fasting", "belly fat"],
        activity: ["exercise", "workout", "train", "gym", "run", "running", "walk", "walking", "yoga", "steps", "swim", "swimming", "sport", "active", "sedentary", "lift", "strength", "cardio", "pain", "knees"]
      };
      for (const [pill, words] of Object.entries(keywords)) {
        if (words.some(w => messageLower.includes(w))) {
          pillar = pill;
          break;
        }
      }

      // 5. Pillar-specific safety checks
      const safetyPrompts = {
        clinical: "Do you have any medical conditions, or are you currently taking medications?",
        mental: "Are you experiencing significant stress, anxiety, depression, or receiving mental health treatment?",
        nutrition: "Do you have any allergies or intolerances (e.g., nuts, dairy, gluten)?",
        activity: "Any injuries, joint issues, or medical conditions affecting your physical activity?"
      };
      if (pillar !== "general" && !context.safety[pillar] && !context.awaitingSafety) {
        context.awaitingSafety = pillar;
        await saveContext();
        return new Response(JSON.stringify({
          response: safetyPrompts[pillar],
          requestContext: pillar
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Handle safety response
      if (context.awaitingSafety) {
        context.safety[context.awaitingSafety] = userMessage;
        context.awaitingSafety = null;
      }

      // 6. Adolescent context check
      let adolescentContext = false;
      const childRegex = /\bmy\s+(\d{1,2})\s*-?\s*year\s*-?\s*old\b/;
      const childMatch = messageLower.match(childRegex);
      if (childMatch) {
        const childAge = parseInt(childMatch[1], 10);
        if (childAge && childAge < 18) {
          adolescentContext = true;
        }
      } else if (messageLower.includes("my teen") || messageLower.includes("my teenager")) {
        adolescentContext = true;
      }

      const userTier = context.tier ? context.tier.toLowerCase() : "free";
      if (adolescentContext && userTier !== "premium" && userTier !== "clinical") {
        const adolescentResponse = 
          "I understand you’re looking for help with a younger person’s weight. Supporting an adolescent’s health is very important! 🌱 " +
          "Generally, the best approach is to **encourage healthy habits** (balanced meals, fun physical activities) and foster a positive body image. Also, consulting with a pediatrician or GP is highly recommended for personalized advice. 🙋‍♀️ " +
          "\n\nFor more in-depth guidance tailored to teens, our **Premium plan** offers specialised coaching for adolescent health. 💡 Consider upgrading to Premium to receive comprehensive support in this sensitive area.";
        const upgradeButtons = [
          { label: "Upgrade to Premium", url: "https://downscaleai.com/premium" }
        ];
        if (context.isAustralian) {
          upgradeButtons.push({ label: "Downscale Clinical (AU)", url: "https://downscaleai.com/clinical" });
          upgradeButtons.push({ label: "Downscale Australia", url: "https://www.downscale.com.au" });
        }
        return new Response(JSON.stringify({
          response: adolescentResponse,
          buttons: upgradeButtons,
          upgradeSuggested: true
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // 7. Additional triggers for medication and diary
      const additionalTriggers = {
        medication: {
          keywords: ["ozempic", "wegovy", "mounjaro", "saxenda", "zepbound", "glp-1", "injection"],
          upsell: { label: "Clinical Medication Support", url: "https://downscaleai.com/clinical" }
        },
        diary: {
          keywords: ["log", "track", "diary", "meal", "hydration", "mood", "activity", "sleep"],
          upsell: { label: "Premium Diary Tracking", url: "https://downscaleai.com/premium" }
        }
      };
      let activeAdditionalTrigger = null;
      for (const [trigger, { keywords }] of Object.entries(additionalTriggers)) {
        if (keywords.some(kw => messageLower.includes(kw))) {
          activeAdditionalTrigger = trigger;
          break;
        }
      }
      if (activeAdditionalTrigger) {
        const upsellButtons = [
          additionalTriggers[activeAdditionalTrigger].upsell,
          context.isAustralian ? { label: "Book with Downscale Clinics (AU)", url: "https://www.downscale.com.au" } : null
        ].filter(Boolean);

        if (activeAdditionalTrigger === "medication" && userTier !== "clinical") {
          return new Response(JSON.stringify({
            response: "Medication-related guidance, including GLP-1 education (e.g., Ozempic, Wegovy), dosing charts, and injection techniques, is available in our Clinical tier.",
            buttons: upsellButtons,
            upgradeSuggested: true
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        } else if (activeAdditionalTrigger === "diary" && userTier !== "premium" && userTier !== "clinical") {
          return new Response(JSON.stringify({
            response: "Would you like to log this in your diary? Our Premium plan includes advanced tracking for meals, hydration, mood, and more.",
            buttons: upsellButtons,
            upgradeSuggested: true
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
      }

      // 8. Monetization check
      if (userTier === "free" && context.responses >= 3) {
        let upsellText = 
          "You’ve reached the limit of free responses. 🎉 *Great job starting your journey!* To continue receiving personalised advice, please consider **upgrading** your plan. " +
          "We offer flexible options to support your weight-loss goals:";
        if (context.isAustralian) {
          upsellText += " As you're in Australia, you might also explore our **Clinical plan** for medical support through DownscaleAU.";
        }
        upsellText += "👇";
        const upgradeButtons = [
          { label: "PAYG", url: "https://downscaleai.com/payg" },
          { label: "Essentials", url: "https://downscaleai.com/essentials" },
          { label: "Premium", url: "https://downscaleai.com/premium" }
        ];
        if (context.isAustralian) {
          upgradeButtons.push({ label: "Clinical (AU Only)", url: "https://downscaleai.com/clinical" });
          upgradeButtons.push({ label: "Downscale Australia", url: "https://www.downscale.com.au" });
        }
        return new Response(JSON.stringify({
          response: upsellText,
          buttons: upgradeButtons,
          upgradeSuggested: true
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // 9. Prepare the OpenAI API request
      const messages = [];
      let systemPrompt = 
        `You are AbeAI, a compassionate Australian weight-loss coach and nutrition assistant. 
        Your advice must align with AbeAI's four pillars: Clinical, Nutrition, Activity, and Mental Health (Mind). 
        Use **Australian English** spelling and include Australian cultural references where appropriate (e.g., Vegemite, Woolworths) to make advice relatable. 
        Maintain a **warm, non-judgmental, motivational tone** – no stigma or shame. Your guidance should feel supportive, like a friendly mentor, following Maslow’s hierarchy by addressing the user's current needs (from basic comfort to confidence and growth). 
        Always prioritize safety: *never* encourage unsafe weight-loss practices (no starvation, no purging, no dangerous shortcuts). If the user requests something unsafe, gently refuse and guide them to healthier alternatives. 
        Explicitly consider user's provided context:
        Allergies: ${context.safety.nutrition || "None"}
        Injuries: ${context.safety.activity || "None"}
        Medications/Clinical conditions: ${context.safety.clinical || "None"}
        Mental Health context: ${context.safety.mental || "None"}`;
      if (pillar === "clinical") {
        systemPrompt += "The user’s question seems to involve **clinical aspects**. Provide evidence-based information and, when appropriate, advise consulting a medical professional (GP) for confirmation or prescription support. ";
      } else if (pillar === "nutrition") {
        systemPrompt += "The user’s question appears **nutrition-related**. Focus on dietary advice: balanced meals, portion control, and healthy Australian food examples (maybe mention fresh produce from Coles or Woolworths, Vegemite on whole-grain toast, etc.). ";
      } else if (pillar === "activity") {
        systemPrompt += "The user’s question appears **activity-related**. Focus on exercise advice: suggest accessible workouts or everyday activities (e.g., walking on the beach, home exercises) and how to integrate movement into daily life. ";
      } else if (pillar === "mental") {
        systemPrompt += "The user’s question appears related to **mindset/mental health**. Respond with empathy and psychological support: address motivation, stress, or emotional factors. Encourage healthy coping (mindfulness, adequate sleep, stress relief techniques). ";
      }
      systemPrompt += "For any advice, keep it **positive and empowering**. Provide clear steps or suggestions the user can realistically follow. End with a motivating follow-up question.";

      messages.push({ role: "system", content: systemPrompt });
      if (context.history && context.history.length > 0) {
        const historySlice = context.history.slice(-6);
        for (const msg of historySlice) {
          messages.push(msg);
        }
      }
      messages.push({ role: "user", content: userMessage });

      // 10. Call OpenAI via Cloudflare AI Gateway
      const openAiPayload = {
        model: "gpt-3.5-turbo",
        messages: messages,
        temperature: 0.7,
        max_tokens: userTier === "free" ? 200 : userTier === "PAYG" ? 250 : userTier === "Essentials" ? 300 : userTier === "Premium" ? 400 : userTier === "Clinical" ? 500 : 200
      };
      const aiResponse = await fetch(
        "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_KEY}`
          },
          body: JSON.stringify(openAiPayload)
        }
      );

      let assistantReply = "";
      if (aiResponse.ok) {
        const result = await aiResponse.json();
        if (result.choices && result.choices.length > 0) {
          assistantReply = result.choices[0].message.content?.trim() || "";
        }
      } else {
        const errText = await aiResponse.text();
        console.error("OpenAI API error:", aiResponse.status, errText);
        throw new Error(`OpenAI API returned an error: ${aiResponse.status} - ${errText}`);
      }

      // 11. Fallback for OpenAI failures
      if (!assistantReply) {
        if (pillar === "clinical") {
          assistantReply = "I'm sorry, I’m having a bit of trouble finding the best advice right now. 🙇‍♀️ When it comes to clinical questions, remember that your GP or pharmacist can be a big help. Always prioritize safe, evidence-based options – you've got this, and your health is important! 💖";
        } else if (pillar === "nutrition") {
          assistantReply = "Oops, something went wrong on my end, but here’s a tip in the meantime: focus on a balanced plate – plenty of veg, some lean protein (maybe a grilled fish or a bit of kangaroo steak for that Aussie twist!), and whole grains. 🥗 Staying consistent and enjoying your food is key. You’re doing great, keep it up! 👍";
        } else if (pillar === "activity") {
          assistantReply = "Apologies, I couldn't get a complete answer for you. 🙁 But let's keep it simple: even a little activity helps. How about a short walk around the block or a quick stretch while watching TV? 🚶 Every bit of movement counts. Keep at it – I believe in you! 💪";
        } else if (pillar === "mental") {
          assistantReply = "Sorry, I’m a bit stuck at the moment. Remember, your mindset matters as much as meals and moves. 😊 Try taking a few deep breaths or a short break – sometimes a cup of tea and a moment of calm can reset your day. ☕️ You’re not alone on this journey, and you’re doing the best you can. Keep your chin up! 🙌";
        } else {
          assistantReply = "I’m sorry, I’m having a little trouble coming up with an answer right now. Just remember: **balanced nutrition**, regular **activity**, and a positive **mindset** together lead to progress. 💡 Every small step counts, so don’t lose hope. You’ve got this, and I’m cheering for you! 🎉";
        }
      } else {
        if (assistantReply.toLowerCase().includes("as an ai") || assistantReply.toLowerCase().includes("cannot assist")) {
          assistantReply = "I’m here to help you on your weight loss journey with kind and practical advice. Let's focus on small, achievable goals – every healthy choice you make is progress! 💕 Keep going, one step at a time.";
        }
      }

      // 12. Update conversation history and user data
      context.history.push({ role: "user", content: userMessage });
      context.history.push({ role: "assistant", content: assistantReply });
      if (userTier === "free") {
        context.responses = (context.responses || 0) + 1;
      }
      await saveContext();

      // 13. Prepare upsell if free or PAYG
      let buttons = [];
      if (userTier === "free" || userTier === "PAYG") {
        buttons = pillar !== "general" ? [
          pillars[pillar].upsell,
          context.isAustralian ? { label: "Book with Downscale Clinics (AU)", url: "https://www.downscale.com.au" } : null
        ].filter(Boolean) : [
          { label: "Pay As You Go", url: "https://downscaleai.com/payg" },
          { label: "Essentials", url: "https://downscaleai.com/essentials" },
          { label: "Premium", url: "https://downscaleai.com/premium" },
          context.isAustralian ? { label: "Clinical (AU Only)", url: "https://downscaleai.com/clinical" } : null,
          context.isAustralian ? { label: "Downscale Australia", url: "https://www.downscale.com.au" } : null
        ].filter(Boolean);
      }

      // 14. Return the final JSON response
      return new Response(JSON.stringify({
        response: assistantReply,
        buttons,
        upgradeSuggested: buttons.length > 0
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      console.error("Worker Error:", err.message, err.stack);
      const errorMsg = "Sorry, I'm having trouble responding right now. 🙇‍♂️ Please try again later.";
      return new Response(JSON.stringify({
        response: errorMsg,
        buttons: [],
        upgradeSuggested: false
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }
};
