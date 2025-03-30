export default {
  async fetch(request, env) {
    try {
      const { message, user_id } = await request.json();

      if (!message || !user_id) {
        return new Response(JSON.stringify({ response: "Invalid request." }), { status: 400 });
      }

      // Get user context (allergies/intolerances) from Cloudflare KV
      let userContext = await env.ABEAI_KV.get(user_id, { type: "json" });
      if (!userContext) {
        userContext = { allergies: [], intolerances: [], allergiesAsked: false };
        await env.ABEAI_KV.put(user_id, JSON.stringify(userContext));
      }

      let systemPrompt = `You are AbeAI, an empathetic, Australian-focused health coach. Follow these guidelines strictly:
      1. Provide brief, empathetic responses.
      2. Use Australian spelling and cultural references.
      3. Adjust responses based on fitness level: beginner.
      4. End each response with a clear and engaging follow-up question.
      `;

      // Ask about allergies/intolerances if relevant & not yet asked
      if (!userContext.allergiesAsked && /snack|meal|food|eat|protein|nutrition/i.test(message)) {
        userContext.allergiesAsked = true;
        await env.ABEAI_KV.put(user_id, JSON.stringify(userContext));

        return new Response(JSON.stringify({
          response: "Before I provide suggestions, could you tell me if you have any food allergies or intolerances?"
        }), { headers: { "Content-Type": "application/json" } });
      }

      // Include allergy/intolerance info if available
      const allergyInfo = userContext.allergies.length || userContext.intolerances.length
        ? `The user has allergies: ${userContext.allergies.join(", ")}, intolerances: ${userContext.intolerances.join(", ")}. Tailor responses accordingly.`
        : "The user has no known allergies or intolerances.";

      systemPrompt += allergyInfo;

      // Call OpenAI API
      const openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo-0125",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
          ],
          temperature: 0.7
        })
      });

      if (!openAIResponse.ok) {
        throw new Error(`OpenAI Error: ${openAIResponse.statusText}`);
      }

      const openAIData = await openAIResponse.json();
      const aiMessage = openAIData.choices[0].message.content.trim();

      return new Response(JSON.stringify({
        response: aiMessage
      }), { headers: { "Content-Type": "application/json" } });

    } catch (err) {
      console.error("Backend Error:", err.message);
      return new Response(JSON.stringify({
        response: "Sorry, something went wrong. Please try again."
      }), { headers: { "Content-Type": "application/json" }, status: 500 });
    }
  }
};
