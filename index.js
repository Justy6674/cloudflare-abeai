const SYSTEM_MESSAGE = "You are AbeAI, a compassionate and knowledgeable health assistant focused on weight loss and wellness. You provide supportive, evidence-based advice. Answer in a friendly, empathetic, and professional tone.";

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      });
    }

    // Only allow POST for the chatbot request
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    let sessionId = null;
    let userMessage = null;
    try {
      const data = await request.json();
      userMessage = data.message;
      sessionId = data.sessionId || null;
    } catch (err) {
      // If parsing JSON fails, return 400 Bad Request
      return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Initialize or retrieve the conversation array from KV
    let conversation = [];
    if (sessionId) {
      const storedData = await env.abeai_kv.get(sessionId, { type: "json" });
      if (storedData && storedData.messages) {
        conversation = storedData.messages;  // retrieve existing conversation
      } else if (Array.isArray(storedData)) {
        conversation = storedData;  // (in case it was stored as an array directly)
      }
    }
    if (conversation.length === 0) {
      // New session: start a new conversation with the system prompt
      conversation.push({ role: "system", content: SYSTEM_MESSAGE });
      if (!sessionId) {
        sessionId = crypto.randomUUID();  // create a new session ID if one was not provided
      }
    }

    // Append the latest user message to the conversation
    conversation.push({ role: "user", content: userMessage });

    // Prepare the OpenAI API request (Chat Completion)
    const openAIEndpoint = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/chat/completions";
    const requestBody = {
      model: "gpt-3.5-turbo",
      messages: conversation
    };

    let openAIResponse;
    try {
      openAIResponse = await fetch(openAIEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`  // include OpenAI API key from secret
        },
        body: JSON.stringify(requestBody)
      });
    } catch (err) {
      // Network error or other fetch failure
      return new Response(JSON.stringify({ error: "Failed to fetch OpenAI API" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Handle non-200 responses from OpenAI (e.g., Unauthorized or other errors)
    if (!openAIResponse.ok) {
      const status = openAIResponse.status;
      let errorMsg = openAIResponse.statusText || "API Error";
      try {
        const errorData = await openAIResponse.json();
        // Extract a meaningful error message if available
        if (errorData.error) {
          errorMsg = (typeof errorData.error === "string")
            ? errorData.error 
            : errorData.error.message || errorMsg;
        }
      } catch (_) {
        // If response isn’t JSON or parsing fails, use status text
      }
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Parse the successful response from OpenAI
    const resultData = await openAIResponse.json();
    const assistantReply = resultData.choices?.[0]?.message?.content || "";
    if (!assistantReply) {
      // If we didn't get a valid assistant message, return an error
      return new Response(JSON.stringify({ error: "No reply from model" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Append assistant reply to the conversation and persist to KV
    conversation.push({ role: "assistant", content: assistantReply });
    try {
      await env.abeai_kv.put(sessionId, JSON.stringify({ messages: conversation }));
    } catch (err) {
      // Log or handle KV write error (non-critical for immediate response)
      console.warn("KV write failed:", err);
    }

    // Send back the assistant’s reply (and the sessionId for reference)
    const responsePayload = { reply: assistantReply, sessionId: sessionId };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
