// notifications.js — Shared bell + realtime listener
(function(){
    const SB_URL='https://binqgggvhbbxetasomhv.supabase.co';
    const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpbnFnZ2d2aGJieGV0YXNvbWh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMjQ1MzYsImV4cCI6MjA5MDkwMDUzNn0.oav0nAJDdPJRpx5qNTY7eA7xqIBi9xqCPsJuRDeloe4';
    let _sb=null,_userId=null,_channel=null;

    function ready(fn){
        if(document.readyState!=='loading') fn();
        else document.addEventListener('DOMContentLoaded',fn);
    }

    ready(async()=>{
        if(typeof supabase==='undefined'){console.warn('supabase not loaded');return}
        _sb=supabase.createClient(SB_URL,SB_KEY);
        const{data:{session}}=await _sb.auth.getSession();
        if(!session) return;
        _userId=session.user.id;
        injectBell();
        if('Notification' in window && Notification.permission==='default'){
            Notification.requestPermission();
        }
        await refreshBadge();
        subscribe();
    });

    function injectBell(){
        const navGroup=document.querySelector('.nav-left-group');
        if(!navGroup||document.getElementById('shared-notif-bell')) return;
        const wrapper=document.createElement('div');
        wrapper.className='notif-bell-shared';
        wrapper.id='shared-notif-bell';
        wrapper.style.cssText='position:relative;margin-left:6px';
        wrapper.innerHTML=`<a href="notifications.html" style="text-decoration:none;color:white;font-size:22px;cursor:pointer">🔔<span id="shared-notif-badge" style="position:absolute;top:-8px;right:-10px;background:#e74c3c;color:white;font-size:9px;padding:2px 5px;border-radius:10px;font-weight:bold;min-width:16px;text-align:center;display:none">0</span></a>`;
        navGroup.insertBefore(wrapper,navGroup.firstChild);
    }

    async function refreshBadge(){
        if(!_sb||!_userId) return;
        const{data}=await _sb.from('notifications').select('id').eq('user_id',_userId).eq('is_read',false);
        const badge=document.getElementById('shared-notif-badge');
        if(!badge) return;
        const c=data?data.length:0;
        if(c>0){badge.textContent=c>99?'99+':c;badge.style.display='inline-block'}
        else badge.style.display='none';
    }
    window.refreshNotifBadge=refreshBadge;

    function subscribe(){
        if(_channel) return;
        _channel=_sb.channel('shared_notif_'+_userId)
            .on('postgres_changes',
                {event:'INSERT',schema:'public',table:'notifications',filter:`user_id=eq.${_userId}`},
                payload=>handleNew(payload.new))
            .subscribe();
    }

    function handleNew(n){
        if('Notification' in window && Notification.permission==='granted'){
            try{
                const notif=new Notification(n.title,{body:n.body,icon:'slogan1.jpg',tag:n.id});
                setTimeout(()=>notif.close(),8000);
                notif.onclick=()=>{window.location.href='notifications.html';notif.close()};
            }catch(e){console.warn(e)}
        }
        playSound(n.severity);
        refreshBadge();
    }

    function playSound(sev){
        try{
            const ctx=new(window.AudioContext||window.webkitAudioContext)();
            const o=ctx.createOscillator();
            const g=ctx.createGain();
            o.connect(g);g.connect(ctx.destination);
            o.frequency.value=sev==='danger'?880:600;
            g.gain.value=0.15;
            o.start();
            o.stop(ctx.currentTime+0.25);
        }catch(e){}
    }
})();