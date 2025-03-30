export default {
  async fetch(request, env) {
    try {
      const { message, user_id } = await request.json();

      const userData = await env.ABEAI_KV.get(`user:${user_id}`, { type: "json" }) || {
        tier: "free",
        allergies: [],
        intolerances: [],
        pendingQuestion: null
      };

      const detectedCategory = detectTrigger(message);
      let aiPrompt = `Answer clearly and empathetically (use Australian English spelling): "${message}"`;

      // Handle single-question prompting logic
      if (detectedCategory === "metrics" && !userData.pendingQuestion) {
        userData.pendingQuestion = "Please provide your current height (cm) and weight (kg) so I can calculate your BMI accurately.";
        await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(userData));
        return jsonResponse({ content: userData.pendingQuestion });
      }

      if (userData.pendingQuestion) {
        aiPrompt += ` The user previously asked: "${userData.pendingQuestion}". Include their provided details from "${message}" in your answer.`;
        userData.pendingQuestion = null;  // Clear pending after receiving response
      }

      if (detectedCategory === "nutrition" && (userData.allergies.length || userData.intolerances.length)) {
        aiPrompt += ` Consider these food allergies/intolerances: ${[...userData.allergies, ...userData.intolerances].join(", ")}. Ensure recommendations avoid these.`;
      }

      if (detectedCategory) {
        aiPrompt += ` Provide a brief, engaging initial response specifically on ${detectedCategory}, keeping it concise (2-3 sentences max), friendly, and relevant to an Australian audience.`;
      } else {
        aiPrompt += " Keep your response brief, helpful, and culturally relevant to Australians.";
      }

      const aiContent = await fetchOpenAI(aiPrompt, env.OPENAI_KEY);

      const response = formatResponse(aiContent, userData, detectedCategory);

      await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(userData));

      return jsonResponse(response);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function fetchOpenAI(prompt, apiKey) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.7
    })
  });

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function detectTrigger(message) {
  const lowerMsg = message.toLowerCase();
  for (const [category, details] of Object.entries(MONETIZATION_TRIGGERS)) {
    if (details.keywords.some(k => lowerMsg.includes(k))) {
      return category;
    }
  }
  return null;
}

function formatResponse(aiContent, userData, detectedCategory) {
  const response = { content: aiContent };

  if (detectedCategory && ["free", "PAYG"].includes(userData.tier)) {
    const trigger = MONETIZATION_TRIGGERS[detectedCategory];
    response.content += `\n\n${trigger.freeResponse}`;
    response.buttons = [{
      text: trigger.button,
      url: `https://downscaleai.com`
    }];
  }

  return response;
}

const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "diet", "nutrition", "food", "eat"],
    freeResponse: "Here are some quick ideas. Interested in personalised meal plans tailored specifically for Aussies?",
    button: "Explore Meal Plans",
    tier: ["Essentials", "Premium"]
  },
  fitness: {
    keywords: ["workout", "exercise", "gym", "run", "activity", "fitness"],
    freeResponse: "Here’s a basic fitness tip. Want a personalised workout program designed for Australians?",
    button: "Get Your Fitness Plan",
    tier: ["Essentials", "Premium"]
  },
  metrics: {
    keywords: ["bmi", "calories", "weight", "body fat", "measurement"],
    freeResponse: "That's a quick insight. Want deeper analysis with medical-grade metrics?",
    button: "Detailed Metrics Analysis",
    tier: ["PAYG", "Essentials", "Premium"]
  },
  hydration: {
    keywords: ["water", "hydration", "drink", "fluid"],
    freeResponse: "Hydration is crucial, especially here in Australia. Want personalised hydration reminders?",
    button: "Activate Hydration Reminders",
    tier: ["Essentials", "Premium"]
  },
  mentalHealth: {
    keywords: ["stress", "sleep", "mood", "anxiety", "mental"],
    freeResponse: "Mental wellness is key. Interested in ongoing mental health support tailored for Australians?",
    button: "Mental Health Coaching",
    tier: ["Premium"]
  },
  intimacy: {
    keywords: ["intimacy", "relationship", "sex", "partner", "marriage"],
    freeResponse: "Relationships matter. Would you like secure, respectful intimacy support?",
    button: "Access Intimacy Coaching",
    tier: ["Premium"]
  },
  childNutrition: {
    keywords: ["kids", "teen", "family", "child", "school lunch", "lunchbox"],
    freeResponse: "Here are some Aussie lunchbox-friendly ideas. Want personalised, family-focused meal plans?",
    button: "Upgrade Family Nutrition",
    tier: ["Essentials", "Premium"]
  },
  medication: {
    keywords: ["medication", "dose", "side effects", "drug", "ozempic", "wegovy", "mounjaro"],
    freeResponse: "Medication requires careful guidance. Looking for comprehensive medication support?",
    button: "Secure Medication Guidance",
    tier: ["Premium"]
  }
};
