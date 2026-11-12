(function () {
  // ModelPixLab Live Waffo Pancake Checkout Mapping (v2 - Multi-language & #payBtn locked)
  const WAFFO_LINKS = {
    '4.9':   'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_0TZrMjQCkJj6D9kRQAE5D1?type=onetime&currency=USD',
    '4.90':  'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_0TZrMjQCkJj6D9kRQAE5D1?type=onetime&currency=USD',
    '12.9':  'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_04hY3AtubODf0rwJNqPyCD?type=onetime&currency=USD',
    '12.90': 'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_04hY3AtubODf0rwJNqPyCD?type=onetime&currency=USD',
    '29.9':  'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_4IeIYfmCaO9cg4TpSaGgIo?type=onetime&currency=USD',
    '29.90': 'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_4IeIYfmCaO9cg4TpSaGgIo?type=onetime&currency=USD',
    '9.9':   'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_6Q68GKFmBo0gPh8zKBRFcJ?type=subscription&currency=USD',
    '9.90':  'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_6Q68GKFmBo0gPh8zKBRFcJ?type=subscription&currency=USD',
    '19.9':  'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_1YlukSzURp7mJW6frGndHC?type=subscription&currency=USD',
    '19.90': 'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_1YlukSzURp7mJW6frGndHC?type=subscription&currency=USD',
    '39.9':  'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_6O3U8r8QWEmwfBdyBy1lID?type=subscription&currency=USD',
    '39.90': 'https://pancake.waffo.ai/store/modelpixlab-xank4juk/product/PROD_6O3U8r8QWEmwfBdyBy1lID?type=subscription&currency=USD'
  };

  function cleanDraftNotices() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    const toUpdate = [];
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.nodeValue || '';
      if (txt.includes('no real payment is processed') || txt.includes('仅作设计预览')) {
        toUpdate.push({ node, val: 'Secured checkout powered by Waffo Pancake (Visa, Mastercard, Apple Pay, Google Pay).' });
      } else if (txt.includes('Design preview') || txt.includes('Design draft')) {
        toUpdate.push({ node, val: '' });
      }
    }
    toUpdate.forEach(item => { item.node.nodeValue = item.val; });
  }

  function resolveCheckoutUrl(btn) {
    const text = (btn.innerText || btn.textContent || '').trim();
    const match = text.match(/\$(\d+\.\d+)/);
    if (match && WAFFO_LINKS[match[1]]) {
      return WAFFO_LINKS[match[1]];
    }
    const container = btn.closest('[role="dialog"], .modal, form, section') || document.body;
    const totalMatch = (container.innerText || '').match(/(?:Total|总计|合計|합계)\s*\$(\d+\.\d+)/i);
    if (totalMatch && WAFFO_LINKS[totalMatch[1]]) {
      return WAFFO_LINKS[totalMatch[1]];
    }
    const anyMatch = (container.innerText || '').match(/\$(4\.90?|12\.90?|29\.90?|9\.90?|19\.90?|39\.90?)/);
    if (anyMatch && WAFFO_LINKS[anyMatch[1]]) {
      return WAFFO_LINKS[anyMatch[1]];
    }
    return WAFFO_LINKS['19.90'];
  }

  // Capture-phase listener runs BEFORE #payBtn's own demo setTimeout handler
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('button, a');
    if (!btn) return;
    const label = (btn.innerText || btn.textContent || '').trim();
    const isPayBtn = btn.id === 'payBtn' || !!btn.querySelector('#payBtnLabel') || /^(?:Pay|支付|立即支付|Pagar|Payer|支払う|결제)\s*\$\d+/i.test(label);
    if (isPayBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      window.location.href = resolveCheckoutUrl(btn);
    }
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cleanDraftNotices);
  } else {
    cleanDraftNotices();
  }
  const obs = new MutationObserver(cleanDraftNotices);
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
