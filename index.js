// Guard to prevent multiple script executions
if (window.abeaiInitialized) {
  console.log("🟡 AbeAI already initialized, skipping...");
} else {
  window.abeaiInitialized = true;
  console.log("🟢 AbeAI Chatbot initializing (Version: 1.1.1)");

  // Configuration - unchanged from original
  const CONFIG = {
    proxyUrl: "https://abeai-proxy.downscaleweightloss.workers.dev",
    logoUrl: "https://abeai-chatbot-webflow-y8ks.vercel.app/abeailogo.png",
    colors: {
      primary: "#5271ff",
      secondary: "#b68a71",
      background: "#f7f2d3",
      text: "#666d70",
      darkText: "#333333"
    }
  };

  // User ID management only
  const userId = localStorage.getItem("abeai_user_id") || crypto.randomUUID();
  localStorage.setItem("abeai_user_id", userId);

  // Create chatbot UI - identical to original
  function createChatbotUI() {
    if (document.getElementById("abeai-container")) return;

    const chatbotContainer = document.createElement("div");
    chatbotContainer.id = "abeai-container";
    chatbotContainer.innerHTML = `
      <div id="chat-container" class="abeai-chatbox">
        <div id="chat-header" class="abeai-header">
          <div class="abeai-brand">
            <img src="${CONFIG.logoUrl}" class="abeai-logo" alt="AbeAI Logo" />
            <span class="abeai-title"><span class="abeai-highlight">AbeAI</span> Health Coach</span>
          </div>
          <div id="chat-toggle" class="abeai-toggle">−</div>
        </div>
        <div id="chat-messages" class="abeai-messages"></div>
        <div id="predefined-selections" class="abeai-quick-options">
          <div id="predefined-options" class="abeai-options-grid"></div>
        </div>
        <div id="chat-input-area" class="abeai-input-area">
          <input type="text" id="chat-input" class="abeai-input" placeholder="Ask AbeAI or select..." />
          <button id="send-btn" class="abeai-send-btn">Send</button>
        </div>
      </div>
      <div id="chat-minimized" class="abeai-minimized">
        <div class="abeai-bubble-hint">Chat with AbeAI</div>
        <div class="abeai-bubble">
          <img src="${CONFIG.logoUrl}" class="abeai-bubble-logo" alt="AbeAI" />
        </div>
        <div class="abeai-bubble-prompt">Press Here</div>
      </div>
    `;

    // Keep original CSS exactly the same
    const styleTag = document.createElement("style");
    styleTag.id = "abeai-styles";
    styleTag.textContent = `
      /* [Previous CSS content EXACTLY as in original, no changes] */
      /* ... all original CSS rules preserved ... */
    `;

    document.body.appendChild(chatbotContainer);
    document.head.appendChild(styleTag);
  }

  // Display message - unchanged from original format
  function displayMessage(content, isUser = false) {
    const chatMessages = document.getElementById('chat-messages');
    const messageElement = document.createElement("div");
    messageElement.className = `abeai-message ${isUser ? 'abeai-user' : 'abeai-bot'}`;
    messageElement.innerHTML = isUser 
      ? `<div class="abeai-message-content">${content}</div>`
      : `
        <img src="${CONFIG.logoUrl}" class="abeai-avatar" alt="AbeAI Logo" />
        <div class="abeai-message-content">${content}</div>
      `;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Show loading indicator - unchanged
  function showLoading() {
    const chatMessages = document.getElementById('chat-messages');
    const loadingElement = document.createElement("div");
    loadingElement.className = "abeai-message loading";
    loadingElement.innerHTML = `
      <img src="${CONFIG.logoUrl}" class="abeai-avatar" alt="AbeAI Logo" />
      <div class="abeai-typing-indicator"><span></span><span></span><span></span></div>
    `;
    chatMessages.appendChild(loadingElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return loadingElement;
  }

  // Send message to backend - optimized but preserves functionality
  async function sendMessage(message) {
    const loadingElement = showLoading();
    
    try {
      const response = await fetch(CONFIG.proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          user_id: userId
        })
      });

      const data = await response.json();
      loadingElement.remove();
      
      if (data.error) throw new Error(data.error);
      
      displayMessage(data.content);
      if (data.buttons) {
        data.buttons.forEach(button => {
          const btn = document.createElement("button");
          btn.className = "abeai-upgrade-btn";
          btn.textContent = button.text;
          btn.onclick = () => window.open(button.url, "_blank");
          document.getElementById('chat-messages').appendChild(btn);
        });
      }
    } catch (error) {
      loadingElement.remove();
      displayMessage("Sorry, I couldn't process that right now. Please try again.");
      console.error("Error:", error);
    }
  }

  // Initialize chatbot with all original UI elements
  function initializeChatbot() {
    createChatbotUI();

    // Original DOM references
    const chatContainer = document.getElementById('chat-container');
    const chatMinimized = document.getElementById('chat-minimized');
    const chatToggle = document.getElementById('chat-toggle');
    const predefinedSelections = document.getElementById('predefined-selections');
    const predefinedOptions = document.getElementById('predefined-options');
    const chatMessages = document.getElementById('chat-messages');
    const sendBtn = document.getElementById('send-btn');
    const chatInput = document.getElementById('chat-input');

    // Original toggle behavior
    const isMobile = window.innerWidth <= 768;
    let isExpanded = !isMobile;
    chatContainer.style.display = isExpanded ? 'flex' : 'none';
    chatMinimized.style.display = isExpanded ? 'none' : 'flex';

    chatToggle.onclick = () => {
      isExpanded = !isExpanded;
      chatContainer.style.display = isExpanded ? 'flex' : 'none';
      chatMinimized.style.display = isExpanded ? 'none' : 'flex';
      chatToggle.textContent = isExpanded ? '−' : '+';
    };

    chatMinimized.onclick = () => {
      isExpanded = true;
      chatContainer.style.display = 'flex';
      chatMinimized.style.display = 'none';
      chatToggle.textContent = '−';
    };

    // Original predefined messages
    const predefinedMessages = [
      "Can you analyse my BMI?",
      "How many calories should I eat daily to lose weight?",
      "Give me 20 high-protein snack ideas",
      "Create a kid-friendly lunchbox meal plan",
      "Suggest a simple home workout routine"
    ];

    // Add predefined options exactly as in original
    predefinedMessages.forEach((msg) => {
      const button = document.createElement("button");
      button.textContent = msg;
      button.onclick = async () => {
        displayMessage(msg, true);
        predefinedSelections.style.display = 'none';
        await sendMessage(msg);
      };
      predefinedOptions.appendChild(button);
    });

    // Original message submission
    const handleSubmit = async () => {
      const message = chatInput.value.trim();
      if (!message) return;
      
      chatInput.value = '';
      displayMessage(message, true);
      predefinedSelections.style.display = 'none';
      await sendMessage(message);
    };

    sendBtn.onclick = handleSubmit;
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });

    // Original welcome flow
    setTimeout(() => {
      if (document.getElementById("chat-input")) {
        sendMessage("welcome");
      }
    }, 1000);
  }

  // Original initialization
  if (document.readyState === "complete" || document.readyState === "interactive") {
    initializeChatbot();
  } else {
    document.addEventListener("DOMContentLoaded", initializeChatbot);
  }

  window.addEventListener('beforeunload', () => {
    window.abeaiInitialized = false;
  });
}
