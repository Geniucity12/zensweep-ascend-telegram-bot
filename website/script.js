// ZenSweep Interactive UI Script

document.addEventListener('DOMContentLoaded', () => {
  // 1. FAQ Accordion Toggle
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    questionBtn.addEventListener('click', () => {
      const isActive = item.classList.contains('active');
      
      // Close all other items
      faqItems.forEach(i => i.classList.remove('active'));
      
      // Toggle current item
      if (!isActive) {
        item.classList.add('active');
      }
    });
  });

  // Open first FAQ item by default
  if (faqItems.length > 0) {
    faqItems[0].classList.add('active');
  }

  // 2. Interactive Mockup Buttons Simulation
  const kbdButtons = document.querySelectorAll('.tg-kbd-btn');
  const chatBody = document.querySelector('.tg-chat-body');

  kbdButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const actionText = btn.textContent.trim();
      
      // Create user simulation message
      const userSimMsg = document.createElement('div');
      userSimMsg.className = 'tg-msg user-msg';
      userSimMsg.innerHTML = `
        <span class="tg-msg-text">${escapeHtml(actionText)}</span>
        <span class="tg-msg-time">${getCurrentTime()}</span>
      `;
      chatBody.appendChild(userSimMsg);

      // Create simulated bot confirmation
      setTimeout(() => {
        const botSimMsg = document.createElement('div');
        botSimMsg.className = 'tg-msg bot-msg';
        
        let replyContent = '';
        if (actionText.includes('Buy')) {
          replyContent = `⚡ <b>Order Simulated:</b> Submitted paper buy for ${actionText.replace('Buy ', '')} on Elysium testnet! Execution time: 140ms.`;
        } else if (actionText.includes('Sell')) {
          replyContent = `📉 <b>Position Closed:</b> Sold ${actionText.replace('Sell ', '')} of $HYPEX holding. Realized PnL: +0.42 HYPE (+18.4%).`;
        } else if (actionText.includes('Refresh')) {
          replyContent = `🔄 <b>Card Refreshed:</b> Block #428,912. Pool liquidity updated.`;
        } else if (actionText.includes('Wallet')) {
          replyContent = `💼 <b>Wallet:</b> 0x93f...b819 · Balance: <b>4.85 HYPE</b> · Chain: Elysium (99801)`;
        } else {
          replyContent = `📊 <b>Status:</b> Telemetry synced with Elysium L2 RPC.`;
        }

        botSimMsg.innerHTML = `
          <div class="bot-card" style="padding: 12px 14px; font-size: 13px;">
            ${replyContent}
          </div>
          <span class="tg-msg-time">${getCurrentTime()}</span>
        `;
        chatBody.appendChild(botSimMsg);
        
        // Scroll to bottom of chat
        chatBody.scrollTop = chatBody.scrollHeight;
      }, 450);
    });
  });

  // Helper: Format current time as HH:MM
  function getCurrentTime() {
    const now = new Date();
    const hrs = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    return `${hrs}:${mins}`;
  }

  // Helper: Escape HTML string
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 3. Command table row click to copy
  const codeBlocks = document.querySelectorAll('.commands-table code, .card-cmd code');
  codeBlocks.forEach(code => {
    code.style.cursor = 'pointer';
    code.title = 'Click to copy';
    code.addEventListener('click', () => {
      const text = code.textContent.trim();
      navigator.clipboard.writeText(text).then(() => {
        const originalText = code.textContent;
        code.textContent = 'Copied!';
        setTimeout(() => {
          code.textContent = originalText;
        }, 1200);
      });
    });
  });
});

