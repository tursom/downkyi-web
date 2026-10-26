import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Clapperboard, FileText, Film, Maximize, Minimize, Monitor, Pause, Play, Subtitles, Volume2, VolumeX } from 'lucide-react';
import './player-review.css';

type Mode = 'cinema' | 'detail';
type MobilePanel = 'playlist' | 'details';
type Props = { initialIndex?: number; initialWatched?: number[]; onClose: () => void; onWatched: (index: number) => void; onCurrentChange?: (index: number) => void };
const MODE_KEY = 'downkyi:prototype:player-mode';
const MOBILE_QUERY = '(max-width: 820px)';
function initialMode(): Mode {
  const requested = new URLSearchParams(window.location.search).get('player');
  if (requested === 'cinema' || requested === 'detail') return requested;
  try { return localStorage.getItem(MODE_KEY) === 'detail' ? 'detail' : 'cinema'; }
  catch { return 'cinema'; }
}
const media = [
  { title: '在阿尔卑斯山，等一场日出', author: '山野之间', duration: '18:42', cover: 'mountain', category: '旅行影像', description: '从山谷走向雪线，把清晨的第一束光留在收藏里。' },
  { title: '东京漫步，把日常拍成电影', author: '散步记录员', duration: '24:50', cover: 'city', category: '城市记录', description: '沿着街角与车站慢慢行走，重新发现日常里的电影感。' },
  { title: '抬头之后，一整夜的银河', author: '星空来信', duration: '12:08', cover: 'sky', category: '星空摄影', description: '等待夜色铺开，在漫长的曝光里收集星光。' },
  { title: '我的家庭服务器搭建手记', author: '不只是数码', duration: '32:16', cover: 'tech', category: '数码生活', description: '从一台小小的服务器开始，为自己的数字收藏安一个家。' },
];
const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${value >= 3600 ? `${Math.floor(value / 3600)}:` : ''}${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

export default function PlayerReview({ initialIndex = 0, initialWatched = [], onClose, onWatched, onCurrentChange }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('playlist');
  const [index, setIndex] = useState(() => Number.isFinite(initialIndex) ? Math.max(0, Math.min(media.length - 1, Math.floor(initialIndex))) : 0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [captions, setCaptions] = useState(false);
  const [captionFailed, setCaptionFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [autoplay, setAutoplay] = useState(false);
  const [watched, setWatched] = useState<number[]>(initialWatched);
  const [feedback, setFeedback] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLTrackElement>(null);
  const returnRef = useRef<HTMLButtonElement>(null);
  const watchedRef = useRef(new Set(initialWatched));
  const indexRef = useRef(index);
  const playRequest = useRef(0);
  const captionIntent = useRef(false);
  const fullscreenRef = useRef(false);
  const escapeGuard = useRef(0);
  const closing = useRef(false);
  const titleId = useId();
  const noticeId = useId();
  const panelId = useId();
  const item = media[index];

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const changed = () => setMobile(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    const track = trackRef.current!;
    // Track load/error events do not bubble; subscribe directly to the element.
    const loaded = () => {
      setCaptionFailed(false);
      track.track.mode = captionIntent.current ? 'showing' : 'hidden';
    };
    const failed = () => {
      captionIntent.current = false;
      track.track.mode = 'disabled';
      setCaptions(false);
      setCaptionFailed(true);
      setFeedback('示例字幕加载失败，请确认 /preview-media/review.vtt 已就绪。');
    };
    track.addEventListener('load', loaded);
    track.addEventListener('error', failed);
    return () => {
      track.removeEventListener('load', loaded);
      track.removeEventListener('error', failed);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const video = videoRef.current;
    const overflow = document.body.style.overflow;
    closing.current = false;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    returnRef.current?.focus();
    const syncFullscreen = () => {
      const active = document.fullscreenElement === stageRef.current;
      if (fullscreenRef.current && !active) escapeGuard.current = performance.now() + 300;
      fullscreenRef.current = active;
      setFullscreen(active);
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      ++playRequest.current;
      video?.pause();
      document.removeEventListener('fullscreenchange', syncFullscreen);
      if (dialog.open) dialog.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function changeMode(next: Mode) {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* Mode remains usable when browser storage is unavailable. */ }
    const url = new URL(window.location.href);
    url.searchParams.set('player', next);
    window.history.replaceState(window.history.state, '', url);
  }

  async function play() {
    const video = videoRef.current;
    if (!video) return;
    const request = ++playRequest.current;
    setFeedback('');
    try { await video.play(); }
    catch (error) {
      if (request !== playRequest.current || closing.current) return;
      setFeedback(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '浏览器阻止了播放，请再次点击播放。'
        : '无法播放本地演示片段，请确认 review.mp4 已就绪且浏览器支持此格式。');
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void play();
    else { ++playRequest.current; video.pause(); }
  }

  function seek(next: number) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    video.currentTime = Math.max(0, Math.min(video.duration, next));
    setTime(video.currentTime);
  }

  function choose(next: number, continuePlaying?: boolean) {
    if (next < 0 || next >= media.length || next === indexRef.current) return;
    const video = videoRef.current;
    const resume = continuePlaying ?? (!!video && !video.paused && !video.ended);
    ++playRequest.current;
    video?.pause();
    if (video && video.readyState > 0) video.currentTime = 0;
    indexRef.current = next;
    setIndex(next);
    onCurrentChange?.(next);
    setTime(0);
    setFeedback('');
    if (resume) void play();
  }

  function markWatched(target = indexRef.current) {
    if (watchedRef.current.has(target)) return;
    watchedRef.current.add(target);
    setWatched([...watchedRef.current]);
    onWatched(target);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        if (!stageRef.current?.requestFullscreen) throw new Error('Fullscreen unavailable');
        await stageRef.current.requestFullscreen();
      }
    } catch { setFeedback('无法切换全屏：浏览器不支持或未允许此次请求。'); }
  }

  async function close() {
    if (closing.current) return;
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); }
      catch { setFeedback('未能退出全屏，请使用浏览器的全屏退出操作后重试。'); return; }
    }
    closing.current = true;
    ++playRequest.current;
    videoRef.current?.pause();
    dialogRef.current?.close();
    onClose();
  }

  function escape() {
    if (document.fullscreenElement) { void toggleFullscreen(); return; }
    if (performance.now() < escapeGuard.current) return;
    void close();
  }

  function toggleCaptions() {
    const track = trackRef.current;
    if (!track || captionFailed) { setFeedback('示例字幕尚不可用，请确认 review.vtt 已就绪。'); return; }
    const next = !captionIntent.current;
    captionIntent.current = next;
    track.track.mode = next ? 'showing' : 'hidden';
    setCaptions(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); escape(); return; }
    if (event.key === 'Tab') {
      const root = document.fullscreenElement ?? event.currentTarget;
      const nodes = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], video[tabindex], [tabindex="0"]')]
        .filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.closest('[hidden], [inert]'));
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!nodes.length) { event.preventDefault(); return; }
      if (!nodes.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('button, input, select, a, textarea, [contenteditable="true"]')) return;
    if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) togglePlay(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); seek((videoRef.current?.currentTime ?? 0) + (event.key === 'ArrowRight' ? 5 : -5));
    }
  }

  return <dialog ref={dialogRef} className={`player-review player-review--${mobile ? 'mobile' : mode}`} aria-modal="true" aria-labelledby={titleId} aria-describedby={noticeId}
    onCancel={event => { event.preventDefault(); escape(); }} onKeyDown={onKeyDown}>
    <header className="review-navigation">
      <button ref={returnRef} type="button" className="review-back" aria-label="返回媒体库" onClick={() => void close()}><ArrowLeft size={18} />返回媒体库</button>
      <span className="review-brand">DownKyi <span>/</span> {mobile || mode === 'cinema' ? '私人放映室' : '媒体详情'}</span>
      {!mobile && <div className="review-mode-picker" role="group" aria-label="观看模式">
        <button type="button" aria-label="影院模式" aria-pressed={mode === 'cinema'} onClick={() => changeMode('cinema')}><Clapperboard size={15} />影院</button>
        <button type="button" aria-label="详情模式" aria-pressed={mode === 'detail'} onClick={() => changeMode('detail')}><Monitor size={15} />详情</button>
      </div>}
      <span className="review-position">片单 <b>{String(index + 1).padStart(2, '0')}</b> / 04</span>
    </header>
    <p className="review-notice" id={noticeId}><span aria-hidden="true" />交互原型 · 本地无声演示片段，非所选视频内容</p>
    <div className="review-workspace">
      <section className="review-heading">
        <div><span className="review-eyebrow">{item.category} / PERSONAL COLLECTION</span><h1 id={titleId}>{item.title}</h1><p>{item.author} <span>·</span> 收藏时长 {item.duration} <span>·</span> 第 {index + 1} / 4 部</p></div>
        <button type="button" className="review-watch-button" aria-label="标记已看" aria-pressed={watched.includes(index)} disabled={watched.includes(index)} onClick={() => markWatched()}><Check size={16} />{watched.includes(index) ? '已看完' : '标记已看'}</button>
      </section>
      <div className="review-stage" ref={stageRef} aria-label="视频播放器">
        <div className="review-screen">
          <video ref={videoRef} src="/preview-media/review.mp4" poster={`/covers/${item.cover}.jpg`} preload="metadata" playsInline tabIndex={0}
            aria-label="演示视频，空格播放或暂停，左右方向键快退快进五秒" onClick={togglePlay}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
            onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
            onLoadedMetadata={event => { setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); setTime(event.currentTarget.currentTime); }}
            onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
            onVolumeChange={event => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }}
            onRateChange={event => setRate(event.currentTarget.playbackRate)}
            onError={() => { setPlaying(false); setFeedback('演示视频加载失败，请确认 /preview-media/review.mp4 已就绪。'); }}
            onEnded={() => { setPlaying(false); markWatched(); if (autoplay && indexRef.current < media.length - 1) choose(indexRef.current + 1, true); }}>
            <track ref={trackRef} kind="subtitles" src="/preview-media/review.vtt" srcLang="zh" label="中文 · 示例字幕" />
          </video>
          <span className="review-screen-label">LOCAL PREVIEW <span>720p 演示</span></span>
        </div>
        <div className="review-controls">
          <input className="review-seek" type="range" aria-label="播放进度" aria-valuetext={`${clock(time)} / ${clock(duration)}`} min={0} max={duration || 1} step={0.1} value={Math.min(time, duration)} disabled={!duration} onChange={event => seek(Number(event.target.value))} />
          <div className="review-control-row">
            <div className="review-transport">
              <button type="button" className="review-play" aria-label={playing ? '暂停' : '播放'} title={playing ? '暂停（空格）' : '播放（空格）'} onClick={togglePlay}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
              <button type="button" aria-label="上一集" title="上一集" disabled={index === 0} onClick={() => choose(index - 1)}><ChevronLeft size={20} /></button>
              <button type="button" aria-label="下一集" title="下一集" disabled={index === media.length - 1} onClick={() => choose(index + 1)}><ChevronRight size={20} /></button>
              <span className="review-time">{clock(time)} <span>/ {clock(duration)}</span></span>
            </div>
            <div className="review-settings">
              <div className="review-volume">
                <button type="button" aria-label={muted ? '取消静音' : '静音'} title="无声样片 · 音量控制可操作" onClick={() => { if (videoRef.current) videoRef.current.muted = !videoRef.current.muted; }}>{muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
                <input type="range" aria-label="音量" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={event => { if (videoRef.current) { videoRef.current.volume = Number(event.target.value); videoRef.current.muted = false; } }} />
              </div>
              <select aria-label="播放速度" value={rate} onChange={event => { if (videoRef.current) videoRef.current.playbackRate = Number(event.target.value); }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select>
              <button type="button" aria-label="字幕" aria-pressed={captions} title={captionFailed ? '字幕加载失败' : '中文示例字幕'} onClick={toggleCaptions}><Subtitles size={20} /></button>
              <button type="button" aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏（Esc）' : '全屏'} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}</button>
            </div>
          </div>
          <p className="review-feedback" role="status" aria-live="polite">{feedback}</p>
        </div>
      </div>
      {mobile && <div className="review-mobile-tabs" role="tablist" aria-label="观看内容" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'playlist' : event.key === 'End' ? 'details' : mobilePanel === 'playlist' ? 'details' : 'playlist';
        setMobilePanel(next);
        document.getElementById(`${panelId}-${next}-tab`)?.focus();
      }}>
        <button type="button" id={`${panelId}-playlist-tab`} role="tab" aria-selected={mobilePanel === 'playlist'} aria-controls={`${panelId}-playlist`} tabIndex={mobilePanel === 'playlist' ? 0 : -1} onClick={() => setMobilePanel('playlist')}>选集 <span>4</span></button>
        <button type="button" id={`${panelId}-details-tab`} role="tab" aria-selected={mobilePanel === 'details'} aria-controls={`${panelId}-details`} tabIndex={mobilePanel === 'details' ? 0 : -1} onClick={() => setMobilePanel('details')}>详情与附件</button>
      </div>}
      <aside className="review-playlist" id={`${panelId}-playlist`} role={mobile ? 'tabpanel' : undefined} aria-label="选集" aria-labelledby={mobile ? `${panelId}-playlist-tab` : undefined} hidden={mobile && mobilePanel !== 'playlist'}>
        <div className="review-list-heading"><div><span className="review-eyebrow">UP NEXT</span><h2>我的片单 <span>04</span></h2></div><Film size={19} /></div>
        <div className="review-autoplay"><span>按片单顺序播放</span><button type="button" role="switch" aria-label="自动连播" aria-checked={autoplay} onClick={() => setAutoplay(value => !value)}><span />自动连播</button></div>
        <ol className="review-episodes">{media.map((entry, position) => <li key={entry.cover}>
          <button type="button" className="review-episode" aria-label={`选集 ${position + 1}：${entry.title}${index === position ? '，当前集' : ''}${watched.includes(position) ? '，已看' : ''}`} aria-current={index === position ? 'true' : undefined} onClick={() => choose(position)}>
            <span className="review-thumbnail"><img src={`/covers/${entry.cover}.jpg`} alt="" /><span>{String(position + 1).padStart(2, '0')}</span>{index === position && <i><Play size={14} fill="currentColor" /></i>}</span>
            <span className="review-episode-copy"><strong>{entry.title}</strong><small>{entry.author}</small><span>{index === position ? '当前集' : `收藏 ${entry.duration}`}{watched.includes(position) && <b><Check size={12} />已看</b>}</span></span>
          </button>
        </li>)}</ol>
        <div className="review-list-footer"><span>{watched.length} / 4 部已看</span><p>观看记录保留于本次评审</p></div>
      </aside>
      <section className="review-details" id={`${panelId}-details`} role={mobile ? 'tabpanel' : undefined} aria-label="媒体详情" aria-labelledby={mobile ? `${panelId}-details-tab` : undefined} hidden={mobile ? mobilePanel !== 'details' : mode !== 'detail'}>
        <div className="review-author"><span className="review-avatar">{item.author.slice(0, 1)}</span><div><span className="review-eyebrow">创作者</span><h2>{item.author}</h2></div><span className="review-detail-tag">{item.category}</span></div>
        <p className="review-description">{item.description}</p>
        <div className="review-detail-grid">
          <section className="review-specs"><h3>媒体规格 <span>提案信息</span></h3><dl><div><dt>收藏规格</dt><dd>1080p · H.264 · MP4</dd></div><div><dt>收藏时长</dt><dd>{item.duration}（示例信息）</dd></div><div><dt>当前演示</dt><dd>720p · 本地无声样片</dd></div><div><dt>样片时长</dt><dd>{duration ? clock(duration) : '等待媒体加载'}</dd></div></dl></section>
          <section className="review-attachments"><h3>附件 <span>本地示例</span></h3><a href="/preview-media/review.vtt" download="review.vtt"><FileText size={19} /><span><strong>中文示例字幕</strong><small>WebVTT · 仅对应演示片段</small></span><span>下载</span></a><p>正式媒体规格与收藏时长为提案信息，不代表当前播放资源。</p></section>
        </div>
      </section>
      <p className="review-shortcuts">空格 播放 / 暂停 <span>← → 跳转 5 秒</span><span>Esc 退出全屏 / 返回</span></p>
    </div>
  </dialog>;
}
