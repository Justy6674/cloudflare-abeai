export default {
  async fetch(request, env, ctx) {
    try {
      // Only accept POST requests (the chatbot backend expects POST with JSON).
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Parse the incoming request JSON.
      const reqData = await request.json();
      const userMessage = reqData.message?.trim();
      let userId = reqData.userId;
      const userName = reqData.name || null;  // optional user name for personalization

      if (!userMessage) {
        return new Response(JSON.stringify({ error: 'No message provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      // If no userId provided, generate a unique ID (e.g., using crypto random UUID or timestamp).
      if (!userId) {
        userId = crypto.randomUUID(); // Unique session/user identifier
      }

      // Retrieve or initialize user session data from KV.
      let sessionData = await env.ABEAI_KV.get(userId, { type: 'json' });
      if (!sessionData) {
        sessionData = {
          tier: 'free',        // default tier
          freeCount: 0,        // number of free responses given
          allergies: null,     // known allergies (nutrition pillar)
          injuries: null,      // known injuries or pain points (activity pillar)
          medications: null,   // known medications/diagnoses (clinical pillar)
          mentalHealth: null,  // known mental health concerns (stress, therapy, etc.)
          history: []          // conversation history messages
        };
      }

      // Quick safety check for crisis or emergency content in user message (suicidal ideation or medical emergency).
      const msgLower = userMessage.toLowerCase();
      const countryCode = request.cf && request.cf.country ? request.cf.country : "";  // e.g., "AU" for Australia
      if (msgLower.includes('suicide') || msgLower.includes('kill myself') || msgLower.includes('end my life')) {
        // Suicide prevention response (direct user to professional help)
        const crisisResponse = countryCode === "AU"
          ? "I'm really sorry that you're feeling like this. It might help to reach out to a professional right away. You can call Lifeline Australia at 13 11 14 or talk to a trusted healthcare provider. You are not alone and help is available."
          : "I'm really sorry that you're feeling like this. Please consider reaching out to a mental health professional or crisis hotline right away. You are not alone and there are people who want to help you.";
        // Do not count this as a free response usage, and do not call OpenAI for this scenario.
        return new Response(JSON.stringify({ userId, answer: crisisResponse }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      if (msgLower.includes('chest pain') || msgLower.includes('heart attack') || msgLower.includes('cant breathe') || msgLower.includes("can't breathe")) {
        // Medical emergency advice
        const emergencyResponse = countryCode === "AU"
          ? "That sounds like a medical emergency. Please stop and call 000 immediately or seek urgent medical care."
          : "That could be a medical emergency. Please call your local emergency number or seek urgent medical care immediately.";
        return new Response(JSON.stringify({ userId, answer: emergencyResponse }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Build the conversation messages for OpenAI (system + history + new user message).
      const messages = [];

      // System role: Instructions for the assistant's behavior and knowledge.
      let systemPrompt = "You are Abe, a compassionate weight-management chatbot assistant. ";
      systemPrompt += "Respond in a supportive, empathetic tone, using Australian English. "; 
      systemPrompt += "Your guidance is based on the four pillars of obesity treatment: clinical (medical), nutrition, physical activity, and mental health. ";
      systemPrompt += "Always prioritize safety and personalization: ask about medications or medical conditions, food allergies, physical injuries, and stress or emotional state if not already known. ";
      systemPrompt += "Incorporate Maslow's hierarchy of needs in your approach: ensure basic needs and safety are addressed before esteem and self-actualization (encouragement and goal-setting). ";
      systemPrompt += "Use culturally relevant Australian examples (e.g., local food, common phrases) where appropriate. ";
      systemPrompt += "Keep answers concise for free tier users, and more detailed for Premium or Clinical tier users. ";
      systemPrompt += "Do NOT provide medical advice beyond your role – for any serious medical issues, urge consulting a healthcare professional (especially in Australia, mention AHPRA guidelines or seeing a GP). ";
      systemPrompt += "If the user seems to need clinical help and is in Australia, gently suggest visiting Downscale Clinical services at www.downscale.com.au. ";
      systemPrompt += "When the user mentions something they could record (meals, hydration, mood, exercise, intimacy, medications, or sleep), end your reply with a question prompting them to log that in their diary. ";
      systemPrompt += "After a few free interactions, if the user is on the free tier, you will suggest our paid plans (Pay-As-You-Go, Essentials, Premium, Clinical) in an empathetic way with the provided URLs.";
      messages.push({ role: 'system', content: systemPrompt });

      // Include conversation history from KV, but truncate based on tier to manage token usage.
      const history = sessionData.history || [];
      let maxHistoryPairs;
      if (sessionData.tier === 'free' || sessionData.tier === 'PAYG' || sessionData.tier === 'Essentials') {
        maxHistoryPairs = 3; // last 3 pairs (user+assistant) for low tiers
      } else {
        maxHistoryPairs = 6; // last 6 pairs for Premium/Clinical for more context
      }
      // Only include the most recent n pairs of messages
      const startIndex = Math.max(0, history.length - maxHistoryPairs * 2);
      const recentHistory = history.slice(startIndex);
      for (const msg of recentHistory) {
        messages.push(msg);
      }

      // Append the new user message as the last message in the conversation.
      messages.push({ role: 'user', content: userMessage });
      // Update the history in session data for the next call (including this user message; assistant response to be added after OpenAI call).
      sessionData.history = history.concat({ role: 'user', content: userMessage });

      // Determine which OpenAI model and parameters to use based on tier.
      let model = 'gpt-3.5-turbo';
      let maxTokens = 500;
      if (sessionData.tier === 'Premium' || sessionData.tier === 'Clinical') {
        model = 'gpt-3.5-turbo';  // (could switch to 'gpt-4' if available and desired)
        maxTokens = 1000;
      }
      // Compose the OpenAI API request payload.
      const openAiPayload = {
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: maxTokens,
        n: 1
      };

      // Prepare the fetch to OpenAI (via Cloudflare AI Gateway if configured).
      const baseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
      const apiUrl = `${baseUrl}/chat/completions`;
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`
      };

      // Call the OpenAI API (Chat Completion endpoint).
      const aiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(openAiPayload),
      });

      if (!aiResponse.ok) {
        // If OpenAI API call failed (non-2xx), handle error.
        console.error('OpenAI API Error:', aiResponse.status, await aiResponse.text());
        throw new Error(`OpenAI API request failed with status ${aiResponse.status}`);
      }
      const completionData = await aiResponse.json();
      let assistantText = completionData.choices?.[0]?.message?.content;
      if (!assistantText) {
        throw new Error('No response from AI');
      }

      // Trim the assistantText and ensure it’s safe.
      assistantText = assistantText.trim();

      // Check if we should inject an upsell suggestion (for free tier users after 3 free responses).
      if (sessionData.tier === 'free') {
        sessionData.freeCount = (sessionData.freeCount || 0) + 1;
        if (sessionData.freeCount >= 3) {
          // If the user has received 3 or more free answers, append an upsell note.
          assistantText += "\n\n💡 *I’m here to help!* As you continue, consider our more personalized support options for deeper guidance – like Pay-as-You-Go, Essentials, Premium, or Clinical plans. You can explore them at [downscaleai.com](https://downscaleai.com) for even more help on your journey 😊.";
          // (We include a general link or mention, as direct specific links can be included as needed.)
        }
      }

      // Diary prompt injection: detect context keywords in the user's message.
      const lowerMsg = userMessage.toLowerCase();
      let diaryPrompt = "";
      if (lowerMsg.match(/\b(eat|ate|meal|breakfast|lunch|dinner|snack)\b/)) {
        diaryPrompt = "Would you like to log this meal in your diary?";
      } else if (lowerMsg.match(/\b(drink|drank|hydration|water|thirsty)\b/)) {
        diaryPrompt = "Would you like to log your hydration in your diary?";
      } else if (lowerMsg.match(/\b(mood|feeling|felt|emotion|happy|sad|depressed|anxious|angry|stressed|upset|frustrated)\b/)) {
        diaryPrompt = "Would you like to log your mood in your diary?";
      } else if (lowerMsg.match(/\b(exercise|exercising|workout|working out|run|running|walk|walking|gym|training|yoga|physical activity)\b/)) {
        diaryPrompt = "Would you like to log this activity in your diary?";
      } else if (lowerMsg.match(/\b(medication|medications|medicine|insulin|pill|tablet|dose|doses)\b/)) {
        diaryPrompt = "Would you like to log your medication in your diary?";
      } else if (lowerMsg.match(/\b(sleep|slept|insomnia|nap|tired|fatigue|rested)\b/)) {
        diaryPrompt = "Would you like to log your sleep in your diary?";
      } else if (lowerMsg.match(/\b(sex|intimacy|intercourse|intimate)\b/)) {
        diaryPrompt = "Would you like to log this in your intimacy diary?";
      }
      if (diaryPrompt) {
        assistantText += `\n\n${diaryPrompt}`;
      }

      // Add the assistant's response to the history for persistence.
      sessionData.history.push({ role: 'assistant', content: assistantText });

      // Update the KV storage with the new session data (with latest history and counts).
      await env.ABEAI_KV.put(userId, JSON.stringify(sessionData));

      // Return the assistant's response as JSON.
      const responseBody = { userId, answer: assistantText };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',        // allow calls from any origin (Webflow frontend)
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    } catch (err) {
      console.error('Error in worker:', err);
      // Fallback error message to user (generic, without technical details).
      const fallbackMessage = "Oops, something went wrong on my end. I'm sorry about that – let's try again in a moment.";
      return new Response(JSON.stringify({ error: 'Internal Error', answer: fallbackMessage }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
