(() => {
  const canvas = document.getElementById('game');
  const canvasWrap = canvas.parentElement;
  const ctx = canvas.getContext('2d');

  // 逻辑分辨率 —— 固定值，所有绘制代码都按这个坐标系
  const LOGICAL_W = 400;
  const LOGICAL_H = 400;
  const GRID = 20;          // 每格逻辑像素
  const COLS = LOGICAL_W / GRID;  // 20
  const ROWS = LOGICAL_H / GRID;  // 20

  // 让 canvas 自适应容器 + devicePixelRatio 高清渲染
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    // 取宽高较小值，强制正方形绘制区，保证每个格子都是正方形
    const side = Math.min(canvasWrap.clientWidth, canvasWrap.clientHeight);
    if (!side) return;
    canvas.style.width = side + 'px';
    canvas.style.height = side + 'px';
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    // 把物理坐标系映射回逻辑坐标系（400×400），X/Y 缩放一致
    ctx.setTransform(canvas.width / LOGICAL_W, 0, 0, canvas.height / LOGICAL_H, 0, 0);
    if (typeof draw === 'function') draw();
  }

  // ─── 难度配置（单一权威来源）────────────────────────────────
  const DIFFICULTY_MAP = {
    easy:    { label: '简单',   baseSpeed: 280, minSpeed: 160, autoAccel: false,
               hint: '固定速度 280ms，不自动加速' },
    normal:  { label: '普通',   baseSpeed: 200, minSpeed: 110, autoAccel: false,
               hint: '固定速度 200ms，不自动加速' },
    hard:    { label: '困难',   baseSpeed: 140, minSpeed:  85, autoAccel: false,
               hint: '固定速度 140ms，不自动加速' },
    insane:  { label: '疯狂',   baseSpeed:  95, minSpeed:  65, autoAccel: false,
               hint: '固定速度 95ms，挑战极限' },
    dynamic: { label: '动态',   baseSpeed: 210, minSpeed:  80, autoAccel: true,
               hint: '随分数自动加速，经典玩法' },
  };
  const DEFAULT_DIFF = 'normal';
  const LS_DIFF_KEY = 'snake_difficulty';
  const LS_SAVED_NICK = 'snake_saved_nickname';
  const LS_REMEMBER   = 'snake_remember_nickname';
  const LS_SOUND_KEY  = 'snake_sound_enabled';

  // 方向向量
  const DIRS = {
    UP:    { x: 0, y: -1 },
    DOWN:  { x: 0, y: 1 },
    LEFT:  { x: -1, y: 0 },
    RIGHT: { x: 1, y: 0 },
  };
  const OPPOSITE = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

  // ─── 音效模块（Web Audio API 合成，零外部文件）───────────────
  // 惰性初始化：首次用户交互时才创建 AudioContext
  const sfx = (() => {
    let audioCtx = null;
    let masterGain = null;
    let enabled = localStorage.getItem(LS_SOUND_KEY) !== 'false'; // 默认开启

    function ensureCtx() {
      if (audioCtx) {
        // 被浏览器挂起后恢复
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.35; // 主音量（0~1）
      masterGain.connect(audioCtx.destination);
      return audioCtx;
    }

    // 播放一串音符；notes: [{ freq, dur }]，dur 单位秒
    function playTone(notes, { type = 'square', volume = 0.6 } = {}) {
      if (!enabled) return;
      const ctx = ensureCtx();
      if (!ctx) return;
      let t = ctx.currentTime;
      const vol = masterGain ? masterGain.gain.value * volume : volume;
      // 用临时 GainNode 串音符（每个音符带快速 attack/release，避免爆音）
      let prevGain = null;
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(n.freq, t);
        // ADSR：快速 attack + 音符结尾快速 release
        const attack = Math.min(0.01, n.dur * 0.1);
        const release = Math.min(0.04, n.dur * 0.3);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + attack);
        g.gain.setValueAtTime(vol, t + n.dur - release);
        g.gain.linearRampToValueAtTime(0, t + n.dur);
        osc.connect(g).connect(masterGain || ctx.destination);
        osc.start(t);
        osc.stop(t + n.dur + 0.02);
        t += n.dur;
      }
    }

    return {
      isEnabled() { return enabled; },
      toggle() {
        enabled = !enabled;
        localStorage.setItem(LS_SOUND_KEY, enabled ? 'true' : 'false');
        // 切换时给个小反馈（仅在开启后）
        if (enabled) playTone([{ freq: 660, dur: 0.08 }], { type: 'sine' });
        return enabled;
      },
      // 音效事件
      eat() {
        playTone([
          { freq: 880, dur: 0.07 },
          { freq: 1320, dur: 0.09 },
        ], { type: 'square', volume: 0.55 });
      },
      gameover() {
        playTone([
          { freq: 392, dur: 0.14 },   // G4
          { freq: 294, dur: 0.18 },   // D4
          { freq: 196, dur: 0.28 },   // G3
        ], { type: 'sawtooth', volume: 0.5 });
      },
      start() {
        playTone([
          { freq: 523, dur: 0.07 },   // C5
          { freq: 659, dur: 0.07 },   // E5
          { freq: 784, dur: 0.10 },   // G5
        ], { type: 'triangle', volume: 0.5 });
      },
      pause() {
        playTone([{ freq: 440, dur: 0.06 }], { type: 'sine', volume: 0.4 });
      },
      resume() {
        playTone([{ freq: 587, dur: 0.06 }], { type: 'sine', volume: 0.4 });
      },
      click() {
        playTone([{ freq: 660, dur: 0.035 }], { type: 'square', volume: 0.3 });
      },
      submitOk() {
        playTone([
          { freq: 659, dur: 0.06 },
          { freq: 880, dur: 0.06 },
          { freq: 1046, dur: 0.10 },
        ], { type: 'triangle', volume: 0.5 });
      },
      submitFail() {
        playTone([
          { freq: 330, dur: 0.10 },
          { freq: 247, dur: 0.16 },
        ], { type: 'square', volume: 0.4 });
      },
    };
  })();

  // ─── DOM ─────────────────────────────────────────────────────
  const scoreEl = document.getElementById('score');
  const highScoreEl = document.getElementById('highScore');
  const statusEl = document.getElementById('status');
  const difficultyLabelEl = document.getElementById('difficultyLabel');
  const diffHintEl = document.getElementById('diffHint');
  const diffBtnEls = document.querySelectorAll('.diff-btn');
  const soundToggle = document.getElementById('soundToggle');
  const soundIcon = document.getElementById('soundIcon');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const finalScoreEl = document.getElementById('finalScore');
  const submitForm = document.getElementById('submitForm');
  const nicknameInput = document.getElementById('nicknameInput');
  const rememberNicknameChk = document.getElementById('rememberNickname');
  const clearNicknameBtn = document.getElementById('clearNicknameBtn');
  const submitBtn = document.getElementById('submitBtn');
  const submitMsg = document.getElementById('submitMsg');
  const restartBtn = document.getElementById('restartBtn');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const leaderboardEl = document.getElementById('leaderboard');
  const boardNote = document.getElementById('boardNote');
  const netStatus = document.getElementById('netStatus');
  const startHint = document.getElementById('startHint');
  const startHintTitle = document.getElementById('startHintTitle');
  const startHintSub = document.getElementById('startHintSub');
  const startScreen = document.getElementById('startScreen');
  const gameScreen = document.getElementById('gameScreen');
  const startGameBtn = document.getElementById('startGameBtn');
  const changeDiffBtn = document.getElementById('changeDiffBtn');

  // 触感反馈（仅移动端支持时生效）
  const canVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  function haptic(pattern) {
    if (!canVibrate()) return;
    try { navigator.vibrate(pattern); } catch (_) { /* 忽略不支持的环境 */ }
  }

  // ─── 游戏状态 ────────────────────────────────────────────────
  let snake, dir, nextDir, food, score, speed, timerId, running, paused, gameOver;
  let countdownId = null;
  let submitted = false;
  let difficulty = loadDifficulty();

  function loadDifficulty() {
    const saved = localStorage.getItem(LS_DIFF_KEY);
    if (saved && DIFFICULTY_MAP[saved]) return saved;
    return DEFAULT_DIFF;
  }
  function saveDifficulty(d) { localStorage.setItem(LS_DIFF_KEY, d); }
  const cfg = () => DIFFICULTY_MAP[difficulty];

  const localHigh = () => Number(localStorage.getItem('snake_high') || 0);
  const setLocalHigh = (s) => {
    if (s > localHigh()) localStorage.setItem('snake_high', String(s));
  };

  const getSavedNick = () => localStorage.getItem(LS_SAVED_NICK) || '';
  const saveNick = (n) => localStorage.setItem(LS_SAVED_NICK, n);
  const clearSavedNick = () => localStorage.removeItem(LS_SAVED_NICK);
  const shouldRemember = () => localStorage.getItem(LS_REMEMBER) !== 'false';
  const setRemember = (v) => localStorage.setItem(LS_REMEMBER, v ? 'true' : 'false');

  // ─── 难度切换 ────────────────────────────────────────────────
  function setDifficulty(newDiff) {
    if (!DIFFICULTY_MAP[newDiff] || newDiff === difficulty) return;
    difficulty = newDiff;
    saveDifficulty(newDiff);
    applyDifficultyUI();
    speed = cfg().baseSpeed;
    if (running && !paused && !gameOver) restartTimer();
    updateHUD();
    sfx.click();
  }

  function applyDifficultyUI() {
    diffBtnEls.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.diff === difficulty);
    });
    diffHintEl.textContent = cfg().hint;
  }

  function applySoundUI() {
    if (sfx.isEnabled()) {
      soundIcon.textContent = '🔊';
      soundToggle.classList.remove('muted');
      soundToggle.title = '音效：开（点击关闭）';
    } else {
      soundIcon.textContent = '🔇';
      soundToggle.classList.add('muted');
      soundToggle.title = '音效：关（点击开启）';
    }
  }

  // ─── 游戏核心 ────────────────────────────────────────────────
  function reset() {
    // 清掉可能残留的倒计时与游戏计时器
    if (countdownId) { clearInterval(countdownId); countdownId = null; }
    clearInterval(timerId);

    const midX = Math.floor(COLS / 2);
    const midY = Math.floor(ROWS / 2);
    snake = [
      { x: midX, y: midY },
      { x: midX - 1, y: midY },
      { x: midX - 2, y: midY },
    ];
    dir = 'RIGHT';
    nextDir = 'RIGHT';
    score = 0;
    speed = cfg().baseSpeed;
    running = false;
    paused = false;
    gameOver = false;
    submitted = false;
    placeFood();
    updateHUD();
    hideOverlay();
    showStartHint();
    draw();
  }

  function placeFood() {
    while (true) {
      const fx = Math.floor(Math.random() * COLS);
      const fy = Math.floor(Math.random() * ROWS);
      if (!snake.some(s => s.x === fx && s.y === fy)) {
        food = { x: fx, y: fy };
        return;
      }
    }
  }

  function updateHUD() {
    scoreEl.textContent = score;
    highScoreEl.textContent = localHigh();
    difficultyLabelEl.textContent = cfg().label;
    if (gameOver) statusEl.textContent = '已结束';
    else if (paused) statusEl.textContent = '已暂停';
    else if (running) statusEl.textContent = '进行中';
    else statusEl.textContent = '准备开始';
  }

  function step() {
    dir = nextDir;
    const head = snake[0];
    const d = DIRS[dir];
    const newHead = { x: head.x + d.x, y: head.y + d.y };

    // 撞墙
    if (newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS) {
      return endGame();
    }
    // 撞自己（排除尾部，它即将移开）
    if (snake.some((s, i) => i !== snake.length - 1 && s.x === newHead.x && s.y === newHead.y)) {
      return endGame();
    }

    snake.unshift(newHead);

    // 吃食物
    if (newHead.x === food.x && newHead.y === food.y) {
      score += 10;
      placeFood();
      sfx.eat();
      haptic(12);   // 吃到食物轻微震动

      if (cfg().autoAccel) {
        const newSpeed = Math.max(cfg().minSpeed, cfg().baseSpeed - Math.floor(score / 50) * 10);
        if (newSpeed !== speed) {
          speed = newSpeed;
          restartTimer();
        }
      }
    } else {
      snake.pop();
    }

    updateHUD();
    draw();
  }

  function draw() {
    // 使用逻辑坐标系（400×400），ctx.setTransform 已负责放大
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= COLS; i++) {
      ctx.beginPath();
      ctx.moveTo(i * GRID, 0);
      ctx.lineTo(i * GRID, LOGICAL_H);
      ctx.stroke();
    }
    for (let j = 0; j <= ROWS; j++) {
      ctx.beginPath();
      ctx.moveTo(0, j * GRID);
      ctx.lineTo(LOGICAL_W, j * GRID);
      ctx.stroke();
    }

    // 食物（首帧未初始化时跳过）
    if (food) {
      ctx.fillStyle = '#f43f5e';
      const fx = food.x * GRID + GRID / 2;
      const fy = food.y * GRID + GRID / 2;
      ctx.beginPath();
      ctx.arc(fx, fy, GRID / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 蛇
    snake.forEach((seg, i) => {
      const x = seg.x * GRID;
      const y = seg.y * GRID;
      if (i === 0) {
        ctx.fillStyle = '#22c55e';
      } else {
        const t = i / snake.length;
        const g = Math.round(197 - 60 * t);
        ctx.fillStyle = `rgb(34, ${g}, 94)`;
      }
      ctx.fillRect(x + 1, y + 1, GRID - 2, GRID - 2);

      if (i === 0) {
        ctx.fillStyle = '#0b1220';
        const cx = x + GRID / 2;
        const cy = y + GRID / 2;
        const eye = GRID / 6;
        const off = GRID / 4;
        let e1, e2;
        if (dir === 'RIGHT')       { e1 = [cx + off, cy - off]; e2 = [cx + off, cy + off]; }
        else if (dir === 'LEFT')   { e1 = [cx - off, cy - off]; e2 = [cx - off, cy + off]; }
        else if (dir === 'UP')     { e1 = [cx - off, cy - off]; e2 = [cx + off, cy - off]; }
        else                        { e1 = [cx - off, cy + off]; e2 = [cx + off, cy + off]; }
        ctx.beginPath(); ctx.arc(e1[0], e1[1], eye, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(e2[0], e2[1], eye, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  // ─── 界面切换：难度选择页 ⇄ 游戏页 ───────────────────────────
  function showStartScreen() {
    startScreen.classList.remove('hidden');
    gameScreen.classList.add('hidden');
    if (countdownId) { clearInterval(countdownId); countdownId = null; }
    clearInterval(timerId);
    running = false;
    paused = false;
  }

  function showGameScreen() {
    startScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    // 画布刚从隐藏变为可见，需要重新按容器尺寸计算
    resizeCanvas();
  }

  function start() {
    if (startScreen.classList.contains('hidden') === false) return; // 还在难度选择页
    if (gameOver) reset();
    if (running && !paused) return;
    if (countdownId) return;   // 倒计时中不重复触发

    running = true;
    paused = false;
    speed = cfg().baseSpeed;
    updateHUD();
    sfx.start();

    // 3-2-1 倒计时，给玩家反应时间（手机上尤其需要）
    let n = 3;
    showStartHint('3', '点击上下左右转向');
    countdownId = setInterval(() => {
      n -= 1;
      if (n > 0) {
        showStartHint(String(n), '点击上下左右转向');
        haptic(8);
      } else {
        clearInterval(countdownId);
        countdownId = null;
        hideStartHint();
        restartTimer();
        haptic(15);
      }
    }, 450);
  }

  function restartTimer() {
    clearInterval(timerId);
    timerId = setInterval(step, speed);
  }

  function pause() {
    if (!running || gameOver) return;
    if (countdownId) return;   // 倒计时中不响应暂停
    paused = !paused;
    if (paused) {
      clearInterval(timerId);
      sfx.pause();
    } else {
      restartTimer();
      sfx.resume();
    }
    updateHUD();
  }

  function endGame() {
    gameOver = true;
    running = false;
    paused = false;
    if (countdownId) { clearInterval(countdownId); countdownId = null; }
    clearInterval(timerId);
    setLocalHigh(score);
    updateHUD();
    hideStartHint();
    sfx.gameover();
    haptic([40, 60, 90]);   // 结束时长震动，增强反馈
    showOverlay();
  }

  function showStartHint(title, sub) {
    if (!startHint) return;
    const t = title || '轻触开始';
    startHintTitle.textContent = t;
    startHintSub.textContent = sub || '点击画面上下左右控制方向';
    // 倒计时数字放大显示
    startHint.classList.toggle('counting', /^\d$/.test(t));
    startHint.classList.remove('hidden');
  }

  function hideStartHint() {
    if (!startHint) return;
    startHint.classList.add('hidden');
    startHint.classList.remove('counting');
  }

  function showOverlay() {
    overlayTitle.textContent = '游戏结束';
    finalScoreEl.textContent = score;
    submitForm.style.display = submitted ? 'none' : 'block';
    submitMsg.textContent = '';
    submitMsg.className = 'submit-msg';

    // 自动填入上次记住的昵称
    const saved = getSavedNick();
    nicknameInput.value = saved;
    nicknameInput.placeholder = saved ? '' : '输入昵称（最多20字）';
    nicknameInput.focus();
    // 有已保存昵称时显示清除按钮
    clearNicknameBtn.hidden = !saved;

    // 显示"记住昵称"勾选框状态
    rememberNicknameChk.checked = shouldRemember();

    overlay.classList.remove('hidden');
    // 每局结束刷新排行榜
    loadLeaderboard();
    setTimeout(() => nicknameInput.select(), 60);
  }

  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  // ─── 键盘 ────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (!running && !gameOver) start();
      else pause();
      return;
    }
    if (k === 'r' || k === 'R') {
      if (gameScreen.classList.contains('hidden')) return; // 难度选择页不响应
      reset();
      start();
      return;
    }

    let newDir = null;
    if (k === 'ArrowUp' || k === 'w' || k === 'W') newDir = 'UP';
    else if (k === 'ArrowDown' || k === 's' || k === 'S') newDir = 'DOWN';
    else if (k === 'ArrowLeft' || k === 'a' || k === 'A') newDir = 'LEFT';
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') newDir = 'RIGHT';

    if (newDir) {
      e.preventDefault();
      if (dir !== OPPOSITE[newDir]) nextDir = newDir;
    }
  });

  // ─── 事件绑定 ────────────────────────────────────────────────
  startBtn.addEventListener('click', () => start());
  pauseBtn.addEventListener('click', () => pause());
  restartBtn.addEventListener('click', () => { reset(); start(); });

  // 难度选择页 → 进入游戏
  startGameBtn.addEventListener('click', () => {
    sfx.click();
    reset();
    showGameScreen();
    start();
  });

  // 游戏结束弹窗 → 回到难度选择页
  changeDiffBtn.addEventListener('click', () => {
    sfx.click();
    hideOverlay();
    reset();
    showStartScreen();
  });

  diffBtnEls.forEach(btn => {
    btn.addEventListener('click', () => setDifficulty(btn.dataset.diff));
  });

  // 音效开关
  soundToggle.addEventListener('click', () => {
    sfx.toggle();
    applySoundUI();
  });

  // 清除已保存昵称
  clearNicknameBtn.addEventListener('click', () => {
    clearSavedNick();
    nicknameInput.value = '';
    nicknameInput.placeholder = '输入昵称（最多20字）';
    clearNicknameBtn.hidden = true;
    nicknameInput.focus();
    nicknameInput.click();
  });

  // "记住昵称"勾选变化 —— 如果取消记住，也清掉已保存的昵称
  rememberNicknameChk.addEventListener('change', () => {
    const v = rememberNicknameChk.checked;
    setRemember(v);
    if (!v) {
      clearSavedNick();
      // 也把当前输入框里已填的清掉，让用户下次重新输入
      nicknameInput.value = '';
      nicknameInput.placeholder = '输入昵称（最多20字）';
      clearNicknameBtn.hidden = true;
    }
  });

  // 昵称输入时实时同步清除按钮显隐
  nicknameInput.addEventListener('input', () => {
    clearNicknameBtn.hidden = !(getSavedNick() && nicknameInput.value === getSavedNick());
  });

  // 提交分数
  submitBtn.addEventListener('click', async () => {
    const nickname = nicknameInput.value.trim();
    if (!nickname) {
      submitMsg.textContent = '请输入昵称';
      submitMsg.className = 'submit-msg error';
      return;
    }
    if (score <= 0) {
      submitMsg.textContent = '分数为 0 无法提交';
      submitMsg.className = 'submit-msg error';
      return;
    }

    submitBtn.disabled = true;
    submitMsg.textContent = '提交中...';
    submitMsg.className = 'submit-msg';

    try {
      if (!isOnline) throw new Error('OFFLINE');   // 已知离线：直接存本机
      await fetchJSON('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, score }),
      });

      submitted = true;

      // 持久化昵称（根据勾选状态）
      if (rememberNicknameChk.checked) {
        saveNick(nickname);
        setRemember(true);
      } else {
        clearSavedNick();
        setRemember(false);
      }

      sfx.submitOk();
      submitMsg.textContent = '✅ 提交成功！';
      submitForm.style.display = 'none';
      await loadLeaderboard();
    } catch (err) {
      sfx.submitFail();
      const offline = err.message === 'OFFLINE';
      if (offline) {
        // 连不上服务器：成绩存到本机，排行榜同样可用
        isOnline = false;
        updateNetUI();
        addLocalScore(nickname, score);
        submitted = true;
        if (rememberNicknameChk.checked) { saveNick(nickname); setRemember(true); }
        submitMsg.textContent = '⚠️ 未连接服务器，成绩已保存到本机';
        submitMsg.className = 'submit-msg warn';
        submitForm.style.display = 'none';
        setBoardNote(true);
        renderLeaderboard(getLocalLB());
      } else {
        submitMsg.textContent = '❌ ' + err.message;
        submitMsg.className = 'submit-msg error';
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  refreshBtn.addEventListener('click', () => {
    sfx.click();
    loadLeaderboard();
  });

  // ─── 排行榜：优先服务器，连不上时退回本机记录 ────────────────
  const LS_LOCAL_LB = 'snake_local_leaderboard';

  function getLocalLB() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_LOCAL_LB));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function addLocalScore(nickname, sc) {
    const list = getLocalLB();
    list.push({ nickname, score: sc, created_at: new Date().toISOString() });
    list.sort((a, b) => b.score - a.score);
    localStorage.setItem(LS_LOCAL_LB, JSON.stringify(list.slice(0, 10)));
  }

  // 读取 JSON，若返回的是 HTML（说明当前页面不是由 Node 服务托管）则视为离线
  async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) throw new Error('OFFLINE');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function renderLeaderboard(rows) {
    if (!rows || rows.length === 0) {
      leaderboardEl.innerHTML = '<li class="empty">暂无记录，快来上榜吧！</li>';
      return;
    }
    leaderboardEl.innerHTML = rows.map(r => {
      const date = new Date(r.created_at).toLocaleDateString();
      return `<li>
        <span class="lb-left"><span class="nickname" title="${r.nickname}">${r.nickname}</span></span>
        <span class="score-num" title="${date}">${r.score}</span>
      </li>`;
    }).join('');
  }

  function setBoardNote(offline) {
    boardNote.hidden = !offline;
    boardNote.textContent = offline
      ? `离线模式：成绩只存在本机。当前地址 ${location.host}，在线模式需访问电脑局域网 IP:3000`
      : '';
  }

  // ─── 在线 / 离线双模式 ───────────────────────────────────────
  let isOnline = false;

  function updateNetUI() {
    netStatus.textContent = isOnline
      ? '🌐 在线模式'
      : '📴 离线模式（成绩存本机）';
    netStatus.className = 'net-status ' + (isOnline ? 'online' : 'offline');
  }

  // 探测服务器是否可用（3 秒超时），失败即判定离线
  async function checkOnline() {
    netStatus.textContent = '检测连接中…';
    netStatus.className = 'net-status checking';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const data = await fetchJSON('/api/health', { signal: ctrl.signal });
      clearTimeout(timer);
      isOnline = !!(data && data.ok);
    } catch (e) {
      isOnline = false;
    }
    updateNetUI();
    return isOnline;
  }

  netStatus.addEventListener('click', () => {
    sfx.click();
    checkOnline().then(loadLeaderboard);
  });

  async function loadLeaderboard() {
    leaderboardEl.innerHTML = '<li class="empty">加载中...</li>';
    try {
      const rows = await fetchJSON('/api/leaderboard');
      isOnline = true;
      updateNetUI();
      setBoardNote(false);
      renderLeaderboard(rows);
    } catch (err) {
      isOnline = false;
      updateNetUI();
      setBoardNote(true);
      renderLeaderboard(getLocalLB());
    }
  }

  // ─── 方向设置（禁止 180° 反向）───────────────────────────────
  function trySetDir(newDir) {
    if (!newDir || !DIRS[newDir]) return;
    if (dir !== OPPOSITE[newDir]) nextDir = newDir;
  }

  // ─── 控制方式：方向键 / 摇杆 / 点按画面 ──────────────────────
  const LS_CONTROL = 'snake_control_mode';
  const CONTROL_MODES = ['dpad', 'joystick', 'tap'];
  let controlMode = localStorage.getItem(LS_CONTROL);
  if (CONTROL_MODES.indexOf(controlMode) === -1) controlMode = 'dpad';

  const ctrlBtns = document.querySelectorAll('.ctrl-btn');
  const dpad = document.getElementById('dpad');
  const joystick = document.getElementById('joystick');
  const joystickBase = document.getElementById('joystickBase');
  const joystickKnob = document.getElementById('joystickKnob');
  const dpadPause = document.getElementById('dpadPause');

  const CONTROL_HINTS = {
    dpad: '使用屏幕下方方向键控制方向',
    joystick: '拖动屏幕下方摇杆控制方向',
    tap: '点击画面上下左右区域控制方向',
  };

  function applyControlMode() {
    ctrlBtns.forEach(b => b.classList.toggle('active', b.dataset.control === controlMode));
    dpad.classList.toggle('hidden', controlMode !== 'dpad');
    joystick.classList.toggle('hidden', controlMode !== 'joystick');
    gameScreen.classList.toggle('has-pad', controlMode !== 'tap');
    startHintSub.textContent = CONTROL_HINTS[controlMode];
    resizeCanvas();   // 画布尺寸随控制区显隐变化，重新计算
  }

  ctrlBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      controlMode = btn.dataset.control;
      localStorage.setItem(LS_CONTROL, controlMode);
      sfx.click();
      applyControlMode();
    });
  });

  // 十字方向键：按下即转向（pointer 事件同时兼容触摸与鼠标）
  document.querySelectorAll('.dpad-btn[data-dir]').forEach(btn => {
    const press = (e) => {
      e.preventDefault();
      btn.classList.add('pressed');
      trySetDir(btn.dataset.dir);
    };
    const release = () => btn.classList.remove('pressed');
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  // 方向键中心：暂停 / 继续
  dpadPause.addEventListener('click', (e) => {
    e.preventDefault();
    if (gameScreen.classList.contains('hidden')) return;
    if (!running && !gameOver) start();
    else pause();
  });

  // 虚拟摇杆：拖动方向决定蛇的走向
  const JOY_DEAD_ZONE = 0.34;   // 死区（占半径比例），避免轻微抖动误触
  let joyActive = false;

  function joyMove(clientX, clientY) {
    const rect = joystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxR = rect.width / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.hypot(dx, dy);

    // 摇杆帽限制在圆盘内
    const clamped = Math.min(dist, maxR - 8);
    const angle = Math.atan2(dy, dx);
    joystickKnob.style.transform =
      `translate(${Math.cos(angle) * clamped}px, ${Math.sin(angle) * clamped}px)`;

    if (dist < maxR * JOY_DEAD_ZONE) return;   // 死区内不转向
    if (Math.abs(dx) > Math.abs(dy)) trySetDir(dx > 0 ? 'RIGHT' : 'LEFT');
    else trySetDir(dy > 0 ? 'DOWN' : 'UP');
  }

  function joyRelease() {
    if (!joyActive) return;
    joyActive = false;
    joystickKnob.classList.remove('dragging');
    joystickKnob.style.transform = 'translate(0px, 0px)';
  }

  joystickBase.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joyActive = true;
    joystickKnob.classList.add('dragging');
    try { joystickBase.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    joyMove(e.clientX, e.clientY);
  });
  joystickBase.addEventListener('pointermove', (e) => {
    if (!joyActive) return;
    e.preventDefault();
    joyMove(e.clientX, e.clientY);
  });
  joystickBase.addEventListener('pointerup', joyRelease);
  joystickBase.addEventListener('pointercancel', joyRelease);

  // ─── Canvas 触摸滑动（核心玩法）──────────────────────────────
  // touch-action 在 CSS 里已设为 none，这里用 JS 做方向判定
  let touchStartX = 0, touchStartY = 0;
  let swipeMoved = false;   // 本次触摸是否已触发过滑动转向
  const SWIPE_MIN = 20; // 滑动 20px 以上才判定为方向变化

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    swipeMoved = false;
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < SWIPE_MIN) return;

    // 只在方向判定改变时切换（避免一滑就触发多次）
    let newDir;
    if (absX > absY) newDir = dx > 0 ? 'RIGHT' : 'LEFT';
    else newDir = dy > 0 ? 'DOWN' : 'UP';
    trySetDir(newDir);
    swipeMoved = true;
    // 重置起点，让连续滑动（画圈）也能持续触发方向变化
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  // 点击/轻触画面的上、下、左、右区域 → 对应方向
  function handleCanvasTap(clientX, clientY) {
    if (!running && !gameOver) {   // 未开始：轻触即开局
      start();
      return;
    }
    if (!running) return;          // 已结束，交给结束弹窗处理

    const rect = canvas.getBoundingClientRect();
    const relX = (clientX - rect.left) / rect.width - 0.5;  // -0.5 ~ 0.5
    const relY = (clientY - rect.top) / rect.height - 0.5;

    // 离画面中心更远的那条轴决定方向
    let newDir;
    if (Math.abs(relX) > Math.abs(relY)) {
      newDir = relX > 0 ? 'RIGHT' : 'LEFT';
    } else {
      newDir = relY > 0 ? 'DOWN' : 'UP';
    }
    trySetDir(newDir);
    sfx.click();
    haptic(6);
  }

  canvas.addEventListener('touchend', (e) => {
    if (swipeMoved) return;   // 刚才是滑动操作，不当作点击
    const touch = e.changedTouches[0];
    e.preventDefault();
    handleCanvasTap(touch.clientX, touch.clientY);
  }, { passive: false });

  // 桌面端鼠标点击画布：同样按上下左右区域控制
  canvas.addEventListener('click', (e) => {
    handleCanvasTap(e.clientX, e.clientY);
  });

  // 轻触提示层：未开始时开局，倒计时/游戏中则按上下左右区域转向
  startHint.addEventListener('click', (e) => {
    if (!running && !gameOver) { start(); return; }
    if (running) handleCanvasTap(e.clientX, e.clientY);
  });
  startHint.addEventListener('touchstart', (e) => {
    if (running || gameOver) return;
    e.preventDefault();
    start();
  }, { passive: false });

  // 长按不弹出系统菜单（避免打断操作）
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ─── 视口 resize 与 orientationchange ────────────────────────
  // iOS Safari 在 orientationchange 时 clientWidth 有延迟，所以用双保险
  let resizeRafId = null;
  const onResize = () => {
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(() => {
      resizeCanvas();
      if (typeof draw === 'function') draw();
    });
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => {
    // iOS Safari 有 orientationchange → 立即 resize + 延迟一次
    onResize();
    setTimeout(onResize, 150);
  });
  // 视口尺寸真正变化时再 resize（有些浏览器地址栏收起/展开不触发 resize）
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', onResize);
  }

  // ─── 启动 ────────────────────────────────────────────────────
  applyDifficultyUI();
  applySoundUI();
  applyControlMode();  // 恢复上次选择的控制方式（首屏可切换）
  reset();
  showStartScreen();   // 第一屏：难度选择
  checkOnline().then(loadLeaderboard);

  // 首次用户交互时唤醒 AudioContext（浏览器自动播放策略要求）
  const wake = () => {
    // 调用任意 sfx 方法会触发 ensureCtx()
    sfx.isEnabled(); // 仅确保模块已初始化
    document.removeEventListener('keydown', wake);
    document.removeEventListener('click', wake);
  };
  document.addEventListener('keydown', wake);
  document.addEventListener('click', wake);
})();
