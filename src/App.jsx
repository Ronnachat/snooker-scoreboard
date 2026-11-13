import { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';

const BALLS = [
  { name: 'Red', points: 1, color: 'bg-red-600 hover:bg-red-500 text-white border-red-800' },
  { name: 'Yellow', points: 2, color: 'bg-yellow-400 hover:bg-yellow-300 text-slate-900 border-yellow-600' },
  { name: 'Green', points: 3, color: 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-800' },
  { name: 'Brown', points: 4, color: 'bg-amber-800 hover:bg-amber-700 text-white border-amber-950' },
  { name: 'Blue', points: 5, color: 'bg-blue-600 hover:bg-blue-500 text-white border-blue-800' },
  { name: 'Pink', points: 6, color: 'bg-pink-500 hover:bg-pink-400 text-white border-pink-700' },
  { name: 'Black', points: 7, color: 'bg-zinc-900 hover:bg-zinc-800 text-white border-zinc-600' },
];

// ฟังก์ชันสุ่มรหัสห้อง 4 ตัวอักษร (เช่น X9B4)
const generateRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

export default function App() {
  const [room, setRoom] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isSpectator, setIsSpectator] = useState(false); // โหมดดูอย่างเดียว ป้องกันมือลั่น
  const [copied, setCopied] = useState(false);

  // ตรวจสอบ URL ว่ามี ?room=XXXX ติดมาด้วยไหม (กรณีเพื่อนส่งลิงก์มาให้)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = params.get('room');
    if (codeFromUrl) {
      handleJoinRoom(codeFromUrl.toUpperCase());
    }
  }, []);

  // เชื่อมต่อ Supabase Real-time เมื่อเข้าห้องแล้ว
  useEffect(() => {
    if (!room?.id) return;

    const channel = supabase
      .channel(`room_${room.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: `id=eq.${room.id}`,
        },
        (payload) => {
          // อัปเดตหน้าจอทันทีเมื่อข้อมูลใน Database เปลี่ยนแปลง
          setRoom(payload.new);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [room?.id]);

  // สร้างห้องใหม่
  const handleCreateRoom = async () => {
    setLoading(true);
    setErrorMsg('');
    const newCode = generateRoomCode();

    const { data, error } = await supabase
      .from('rooms')
      .insert([{ room_code: newCode }])
      .select()
      .single();

    setLoading(false);
    if (error) {
      setErrorMsg('สร้างห้องไม่สำเร็จ: ' + error.message);
      return;
    }

    setRoom(data);
    window.history.pushState({}, '', `?room=${data.room_code}`);
  };

  // เข้าร่วมห้องที่มีอยู่
  const handleJoinRoom = async (codeToJoin) => {
    const targetCode = (codeToJoin || joinCode).trim().toUpperCase();
    if (!targetCode) return;

    setLoading(true);
    setErrorMsg('');

    const { data, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('room_code', targetCode)
      .single();

    setLoading(false);
    if (error || !data) {
      setErrorMsg('ไม่พบห้องรหัสนี้ กรุณาตรวจสอบอีกครั้ง');
      return;
    }

    setRoom(data);
    window.history.pushState({}, '', `?room=${data.room_code}`);
  };

  // ฟังก์ชันกลางสำหรับอัปเดตคะแนนขึ้น Cloud และเก็บประวัติ Undo
  const updateRoomState = async (newFields, actionType, ballName = null, points = 0) => {
    if (!room || isSpectator) return;

    // เก็บค่าปัจจุบันไว้เผื่อกด Undo
    const prevState = {
      p1_score: room.p1_score,
      p2_score: room.p2_score,
      p1_frames: room.p1_frames,
      p2_frames: room.p2_frames,
      active_player: room.active_player,
      current_break: room.current_break,
      reds_remaining: room.reds_remaining,
    };

    // Optimistic UI: อัปเดตหน้าจอตัวเองทันทีให้ลื่นไหลไม่ต้องรอเน็ต
    setRoom((prev) => ({ ...prev, ...newFields }));

    // บันทึกประวัติลง score_events
    await supabase.from('score_events').insert([
      {
        room_id: room.id,
        player: room.active_player,
        action_type: actionType,
        ball_name: ballName,
        points: points,
        prev_state: prevState,
      },
    ]);

    // อัปเดตข้อมูลหลักในตาราง rooms (จะไปกระตุ้น Realtime ให้เครื่องอื่นเห็นด้วย)
    await supabase.from('rooms').update(newFields).eq('id', room.id);
  };

  // กดลูกสี
  const handlePotBall = (ball) => {
    const isP1 = room.active_player === 1;
    const newReds =
      ball.name === 'Red' && room.reds_remaining > 0
        ? room.reds_remaining - 1
        : room.reds_remaining;

    updateRoomState(
      {
        p1_score: isP1 ? room.p1_score + ball.points : room.p1_score,
        p2_score: !isP1 ? room.p2_score + ball.points : room.p2_score,
        current_break: room.current_break + ball.points,
        reds_remaining: newReds,
      },
      'POT',
      ball.name,
      ball.points
    );
  };

  // สลับไม้แทง
  const handleSwitchTurn = () => {
    updateRoomState(
      {
        active_player: room.active_player === 1 ? 2 : 1,
        current_break: 0,
      },
      'SWITCH_TURN'
    );
  };

  // กดฟาวล์
  const handleFoul = (foulPoints) => {
    const isP1 = room.active_player === 1;
    updateRoomState(
      {
        p1_score: !isP1 ? room.p1_score + foulPoints : room.p1_score,
        p2_score: isP1 ? room.p2_score + foulPoints : room.p2_score,
        active_player: isP1 ? 2 : 1,
        current_break: 0,
      },
      'FOUL',
      null,
      foulPoints
    );
  };

  // จบเฟรม
  const handleNextFrame = () => {
    if (room.p1_score === room.p2_score) {
      alert('คะแนนยังเสมอกันอยู่ กรุณาชิงดำก่อนจบเฟรม!');
      return;
    }
    const p1Won = room.p1_score > room.p2_score;
    updateRoomState(
      {
        p1_score: 0,
        p2_score: 0,
        p1_frames: p1Won ? room.p1_frames + 1 : room.p1_frames,
        p2_frames: !p1Won ? room.p2_frames + 1 : room.p2_frames,
        current_break: 0,
        reds_remaining: 6,
        active_player: room.active_player === 1 ? 2 : 1,
      },
      'NEXT_FRAME'
    );
  };

  // ย้อนกลับ (Undo จาก Database)
  const handleUndo = async () => {
    if (!room || isSpectator) return;

    // ดึงรายการล่าสุดของห้องนี้
    const { data: events } = await supabase
      .from('score_events')
      .select('*')
      .eq('room_id', room.id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!events || events.length === 0) return;

    const lastEvent = events[0];
    // คืนค่าสถานะก่อนหน้า
    setRoom((prev) => ({ ...prev, ...lastEvent.prev_state }));
    await supabase.from('rooms').update(lastEvent.prev_state).eq('id', room.id);
    // ลบประวัติรายการที่เพิ่ง Undo ทิ้ง
    await supabase.from('score_events').delete().eq('id', lastEvent.id);
  };

  // เปลี่ยนชื่อผู้เล่น
  const handleNameChange = async (playerNum, newName) => {
    const field = playerNum === 1 ? { p1_name: newName } : { p2_name: newName };
    setRoom((prev) => ({ ...prev, ...field }));
    await supabase.from('rooms').update(field).eq('id', room.id);
  };

  // คัดลอกลิงก์ห้องส่งให้เพื่อน
  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ออกจากห้องกลับหน้าแรก
  const handleLeaveRoom = () => {
    setRoom(null);
    window.history.pushState({}, '', '/');
  };

  // ==========================================
  // หน้าจอที่ 1: Lobby (สร้างห้อง / เข้าห้อง)
  // ==========================================
  if (!room) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl text-center">
          <div className="text-5xl mb-3">🎱</div>
          <h1 className="text-2xl font-black text-emerald-400 tracking-wide mb-1">
            6-RED SNOOKER
          </h1>
          <p className="text-slate-400 text-sm mb-8">
            ระบบบันทึกคะแนนสนุกเกอร์ออนไลน์ Real-time
          </p>

          {/* ปุ่มสร้างห้องใหม่ */}
          <button
            onClick={handleCreateRoom}
            disabled={loading}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 px-6 rounded-2xl shadow-lg shadow-emerald-600/20 active:scale-95 transition text-lg mb-6"
          >
            {loading ? 'กำลังสร้างห้อง...' : '➕ สร้างห้องแข่งขันใหม่'}
          </button>

          <div className="relative flex py-3 items-center mb-6">
            <div className="flex-grow border-t border-slate-800"></div>
            <span className="flex-shrink mx-4 text-slate-500 text-xs uppercase font-semibold">
              หรือเข้าร่วมห้องที่มีอยู่
            </span>
            <div className="flex-grow border-t border-slate-800"></div>
          </div>

          {/* ฟอร์มกรอกรหัสเข้าห้อง */}
          <div className="flex gap-2">
            <input
              type="text"
              maxLength={4}
              placeholder="รหัส 4 ตัว (เช่น A8K2)"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-center font-bold tracking-widest uppercase text-lg focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={() => handleJoinRoom()}
              disabled={loading || joinCode.length < 4}
              className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-white font-bold px-6 rounded-xl transition"
            >
              เข้าห้อง
            </button>
          </div>

          {errorMsg && (
            <p className="text-rose-400 text-sm mt-4 bg-rose-950/50 py-2 px-3 rounded-lg border border-rose-800/50">
              {errorMsg}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ==========================================
  // หน้าจอที่ 2: Scoreboard หลัก (Real-time)
  // ==========================================
  const scoreDiff = Math.abs(room.p1_score - room.p2_score);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-4 font-sans select-none">
      {/* Top Room Bar */}
      <div className="w-full max-w-3xl flex flex-wrap justify-between items-center gap-2 mb-3 px-1">
        <button
          onClick={handleLeaveRoom}
          className="text-xs text-slate-400 hover:text-white bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg"
        >
          ← ออกจากห้อง
        </button>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">รหัสห้อง:</span>
          <span className="bg-emerald-950 text-emerald-400 border border-emerald-700/50 font-mono font-black px-3 py-1 rounded-lg tracking-widest">
            {room.room_code}
          </span>
          <button
            onClick={handleCopyLink}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg transition"
          >
            {copied ? '✅ คัดลอกลิงก์แล้ว!' : '🔗 แชร์ลิงก์'}
          </button>
        </div>

        {/* ปุ่มสลับโหมดผู้ชม */}
        <button
          onClick={() => setIsSpectator(!isSpectator)}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition ${
            isSpectator
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
              : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
          }`}
        >
          {isSpectator ? '👁️ โหมดผู้ชม (ล็อกปุ่ม)' : '🎮 โหมดคนกดคะแนน'}
        </button>
      </div>

      {/* Header & Frame Info */}
      <header className="w-full max-w-3xl flex justify-between items-center py-3 px-4 bg-slate-900 rounded-xl border border-slate-800 mb-4">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <h1 className="font-bold text-sm sm:text-base tracking-wide text-emerald-400">
            LIVE SCOREBOARD
          </h1>
        </div>
        <div className="flex items-center gap-3 text-xs sm:text-sm">
          <span className="bg-slate-800 px-3 py-1 rounded-full text-slate-300">
            แดงเหลือ: <strong className="text-red-500 text-base">{room.reds_remaining}</strong>
          </span>
          <span className="bg-slate-800 px-3 py-1 rounded-full text-slate-300">
            ห่าง: <strong className="text-amber-400 text-base">{scoreDiff}</strong>
          </span>
        </div>
      </header>

      {/* Main Scoreboard */}
      <main className="w-full max-w-3xl grid grid-cols-2 gap-4 mb-4">
        {/* Player 1 Card */}
        <div
          onClick={() => !isSpectator && room.active_player !== 1 && handleSwitchTurn()}
          className={`relative p-5 sm:p-6 rounded-2xl border-2 transition-all flex flex-col items-center justify-between ${
            isSpectator ? 'cursor-default' : 'cursor-pointer'
          } ${
            room.active_player === 1
              ? 'bg-slate-900 border-emerald-500 shadow-lg shadow-emerald-500/10'
              : 'bg-slate-900/50 border-slate-800 opacity-75'
          }`}
        >
          {room.active_player === 1 && (
            <span className="absolute -top-3 bg-emerald-500 text-slate-950 text-xs font-extrabold px-3 py-0.5 rounded-full uppercase tracking-wider">
              กำลังแทง
            </span>
          )}
          <input
            type="text"
            disabled={isSpectator}
            value={room.p1_name}
            onChange={(e) => handleNameChange(1, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="bg-transparent text-center font-semibold text-lg sm:text-xl text-slate-200 focus:outline-none focus:border-b border-emerald-500 w-full mb-2 disabled:opacity-100"
          />
          <div className="text-6xl sm:text-8xl font-black tracking-tight my-2 tabular-nums">
            {room.p1_score}
          </div>
          <div className="text-xs sm:text-sm font-medium text-slate-400 bg-slate-800/80 px-4 py-1 rounded-full">
            Frames: <span className="text-white font-bold text-base">{room.p1_frames}</span>
          </div>
        </div>

        {/* Player 2 Card */}
        <div
          onClick={() => !isSpectator && room.active_player !== 2 && handleSwitchTurn()}
          className={`relative p-5 sm:p-6 rounded-2xl border-2 transition-all flex flex-col items-center justify-between ${
            isSpectator ? 'cursor-default' : 'cursor-pointer'
          } ${
            room.active_player === 2
              ? 'bg-slate-900 border-emerald-500 shadow-lg shadow-emerald-500/10'
              : 'bg-slate-900/50 border-slate-800 opacity-75'
          }`}
        >
          {room.active_player === 2 && (
            <span className="absolute -top-3 bg-emerald-500 text-slate-950 text-xs font-extrabold px-3 py-0.5 rounded-full uppercase tracking-wider">
              กำลังแทง
            </span>
          )}
          <input
            type="text"
            disabled={isSpectator}
            value={room.p2_name}
            onChange={(e) => handleNameChange(2, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="bg-transparent text-center font-semibold text-lg sm:text-xl text-slate-200 focus:outline-none focus:border-b border-emerald-500 w-full mb-2 disabled:opacity-100"
          />
          <div className="text-6xl sm:text-8xl font-black tracking-tight my-2 tabular-nums">
            {room.p2_score}
          </div>
          <div className="text-xs sm:text-sm font-medium text-slate-400 bg-slate-800/80 px-4 py-1 rounded-full">
            Frames: <span className="text-white font-bold text-base">{room.p2_frames}</span>
          </div>
        </div>
      </main>

      {/* Current Break Banner */}
      <div className="w-full max-w-3xl bg-slate-900 border border-slate-800 rounded-xl p-3 mb-6 flex justify-between items-center px-6">
        <span className="text-slate-400 text-sm sm:text-base font-medium">
          Current Break (เบรกไม้ปัจจุบัน)
        </span>
        <span className="text-3xl font-extrabold text-amber-400 tabular-nums">
          {room.current_break}
        </span>
      </div>

      {/* แสดงปุ่มควบคุมเฉพาะเมื่อไม่ได้อยู่ในโหมดผู้ชม */}
      {!isSpectator ? (
        <>
          {/* Ball Controls */}
          <section className="w-full max-w-3xl mb-6">
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
              {BALLS.map((ball) => (
                <button
                  key={ball.name}
                  onClick={() => handlePotBall(ball)}
                  disabled={ball.name === 'Red' && room.reds_remaining === 0}
                  className={`${ball.color} aspect-square rounded-full border-b-4 flex flex-col items-center justify-center shadow-md active:scale-95 transition-transform disabled:opacity-25 disabled:cursor-not-allowed`}
                >
                  <span className="text-xl md:text-2xl font-black">{ball.points}</span>
                  <span className="text-[11px] font-semibold uppercase opacity-90">{ball.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Action & Foul Controls */}
          <section className="w-full max-w-3xl grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <button
              onClick={handleSwitchTurn}
              className="col-span-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3.5 px-4 rounded-xl shadow active:scale-95 transition"
            >
              🔄 สลับไม้แทง (End Turn)
            </button>

            <button
              onClick={handleUndo}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold py-3.5 px-4 rounded-xl border border-slate-700 active:scale-95 transition"
            >
              ↩️ Undo
            </button>

            <button
              onClick={handleNextFrame}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3.5 px-4 rounded-xl shadow active:scale-95 transition"
            >
              🏆 จบเฟรม (End Frame)
            </button>
          </section>

          {/* Foul Quick Buttons */}
          <section className="w-full max-w-3xl bg-slate-900/70 border border-slate-800/80 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider px-2">
              ⚠️ ฟาวล์ (บวกแต้มให้อีกฝั่ง):
            </span>
            <div className="flex gap-2">
              {[4, 5, 6, 7].map((pts) => (
                <button
                  key={pts}
                  onClick={() => handleFoul(pts)}
                  className="bg-rose-950/80 hover:bg-rose-800 text-rose-200 border border-rose-800/60 font-bold px-4 py-1.5 rounded-lg text-sm active:scale-95 transition"
                >
                  +{pts}
                </button>
              ))}
            </div>
          </section>
        </>
      ) : (
        <div className="w-full max-w-3xl text-center py-6 bg-slate-900/50 border border-slate-800/80 rounded-2xl text-slate-400 text-sm">
          กำลังรับชมการแข่งขันแบบ Real-time คะแนนจะอัปเดตอัตโนมัติเมื่อผู้บันทึกกดคะแนน
        </div>
      )}
    </div>
  );
}