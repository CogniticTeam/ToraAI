import {motion} from 'framer-motion';
import {ArrowLeft,Eye,EyeOff,KeyRound,Languages,LoaderCircle} from 'lucide-react';
import {lazy,Suspense,useEffect,useRef,useState} from 'react';

import {Turnstile,type TurnstileHandle} from './Turnstile';
import {useMotionSettings} from '@/hooks/useMotionSettings';
import {useTranslation} from '@/i18n/useI18n';
import {AuthFlowError,authRequest,beginPasskey,waitPasskey,cancelPasskeyRequest,type AuthProfile,type PasskeyHandoff} from '@/lib/authFlow';
import {getToken} from '@/utils/authStore';
import './login-surface.css';

const LanguageDialog=lazy(async()=>({default:(await import('@/components/dialog/LanguageDialog')).LanguageDialog}));
type Stage='entry'|'methods'|'email'|'password'|'signupPassword'|'challenge'|'code'|'resetPassword'|'passkey';
type Intent='login'|'signup'|'reset';
const validEmail=(value:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function AuthField({label,value,onChange,password=false,...props}:{label:string;value:string;onChange:(value:string)=>void;password?:boolean}&Omit<React.InputHTMLAttributes<HTMLInputElement>,'onChange'|'value'>){
 const [show,setShow]=useState(false);const{t}=useTranslation();
 return <label className="tora-auth-field"><span>{label}</span><input {...props} aria-label={label} placeholder={label} value={value} onChange={event=>onChange(event.target.value)} type={password&&!show?'password':props.type??'text'} spellCheck={false}/>{password&&<button type="button" className="tora-auth-eye" aria-label={t(show?'settings.account.hidePassword':'settings.account.showPassword')} onClick={()=>setShow(value=>!value)}>{show?<EyeOff/>:<Eye/>}</button>}</label>;
}

function AuthAction({label,onClick,disabled,secondary=false,icon,loading=false}:{label:string;onClick:()=>void;disabled:boolean;secondary?:boolean;icon?:React.ReactNode;loading?:boolean}) {
 return <button type="button" className={secondary?'tora-auth-secondary':'tora-auth-primary'} disabled={disabled} aria-busy={loading || undefined} onClick={onClick}>{loading?<LoaderCircle className="tora-auth-submit-spinner" aria-hidden="true"/>:icon}<span>{label}</span></button>;
}

export function AuthFlow({onAuthenticated}:{onAuthenticated:(profile:AuthProfile)=>Promise<void>|void}){
 const motionSettings=useMotionSettings();
 const{t,i18n}=useTranslation();const copy=(key:string,values?:Record<string,unknown>)=>t(`authFlow.${key}`,values);
 const[stage,setStage]=useState<Stage>('entry'),[intent,setIntent]=useState<Intent>('login');
 const[loginMethod,setLoginMethod]=useState<'password'|'code'>('password');
 const[account,setAccount]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState(''),[resetToken,setResetToken]=useState('');
 const[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[languageOpen,setLanguageOpen]=useState(false);
 const[challengeMode,setChallengeMode]=useState<'password'|'email'>('password'),[proof,setProof]=useState(''),[cooldown,setCooldown]=useState(0),[handoff,setHandoff]=useState<PasskeyHandoff|null>(null);
 const turnstile=useRef<TurnstileHandle>(null),pending=useRef<AbortController|null>(null);
 useEffect(()=>()=>pending.current?.abort(),[]);
 useEffect(()=>{if(cooldown<=0)return;const timer=window.setInterval(()=>setCooldown(value=>Math.max(0,value-1)),1000);return()=>window.clearInterval(timer);},[cooldown]);
 const move=(next:Stage)=>{setStage(next);setError(null);setProof('');};
 const fail=(cause:unknown)=>{const key=cause instanceof AuthFlowError?cause.code:'network';setError(copy(`errors.${key}`,{defaultValue:copy('errors.request_failed')}));};
 const action=async(run:(signal:AbortSignal)=>Promise<void>)=>{
  if(busy)return;const controller=new AbortController();pending.current?.abort();pending.current=controller;setBusy(true);setError(null);
  try{await run(controller.signal);}catch(cause){if(!controller.signal.aborted)fail(cause);}finally{if(!controller.signal.aborted)setBusy(false);}
 };
 const finish=async(profile:AuthProfile,signal:AbortSignal,initialToken:string|null)=>{if(signal.aborted||getToken()!==initialToken)throw new DOMException('Canceled','AbortError');if(typeof profile.token!=='string'||!profile.token||typeof profile.email!=='string'||!validEmail(profile.email))throw new AuthFlowError('request_failed');await onAuthenticated(profile);};
 const lookup=()=>action(async signal=>{
  const value=account.trim();if(!value)throw new AuthFlowError('invalid_email');
  const result=await authRequest<{registered:boolean}>('/auth/check',{account:value},{signal});
  if(!result.registered&&!validEmail(value))throw new AuthFlowError('invalid_email');
  setIntent(result.registered?'login':'signup');setPassword('');if(result.registered&&loginMethod==='code'){requestChallenge('login','email');}else move(result.registered?'password':'signupPassword');
 });
 const requestChallenge=(purpose:Intent,mode:'password'|'email')=>{if(mode==='email'&&!validEmail(account.trim())){setError(copy('errors.invalid_email'));return;}setIntent(purpose);setChallengeMode(mode);move('challenge');};
 const challenge=()=>action(async signal=>{
  const initialToken=getToken();
  if(challengeMode==='password'){
   const result=await authRequest<AuthProfile>('/auth/login',{account:account.trim(),password,'cf-turnstile-response':proof},{signal});await finish(result,signal,initialToken);
  }else{await authRequest('/auth/email-code',{email:account.trim(),purpose:intent,'cf-turnstile-response':proof},{signal});setCooldown(60);setCode('');move('code');}
 }).finally(()=>turnstile.current?.reset());
 const verifyCode=()=>action(async signal=>{
  const initialToken=getToken();
  if(intent==='reset'){const result=await authRequest<{resetToken:string}>('/auth/reset-verify',{email:account.trim(),code},{signal});setResetToken(result.resetToken);setPassword('');move('resetPassword');return;}
  const result=await authRequest<AuthProfile>(intent==='signup'?'/auth/signup':'/auth/email-login',{email:account.trim(),code,...(intent==='signup'?{password}:{})},{signal});await finish(result,signal,initialToken);
 });
 const resetPassword=()=>action(async signal=>{await authRequest('/auth/reset-password',{email:account.trim(),password,resetToken},{signal});setPassword('');setCode('');setResetToken('');setNotice(copy('passwordReset'));move('entry');});
 const startPasskeyLogin=()=>action(async signal=>{
  const initialToken=getToken();const flow=await beginPasskey('login',{...((stage==='email'||stage==='password')&&account.trim()?{account:account.trim()}:{}),language:i18n.language},signal);
  setHandoff(flow);move('passkey');window.open(flow.url,'_blank','noopener,noreferrer');
  try{const result=await waitPasskey(flow,signal);await finish(result as AuthProfile,signal,initialToken);}finally{if(signal.aborted)void cancelPasskeyRequest(flow);}
 });
 const cancelPasskey=()=>{pending.current?.abort();pending.current=null;setBusy(false);setHandoff(null);move('entry');};
 const identity=<div className="tora-auth-identity"><span className="tora-auth-identity-label">{copy('email')}</span><span dir="auto">{account}</span><button type="button" disabled={busy} onClick={()=>move('email')}>{copy('edit')}</button></div>;
 const footer=<p className="tora-auth-legal">{copy('legal')} <a href="https://ohfun.online/terms/" target="_blank" rel="noopener noreferrer">{copy('terms')}</a> {copy('and')} <a href="https://ohfun.online/privacy/" target="_blank" rel="noopener noreferrer">{copy('privacy')}</a></p>;
 return <main className="app-drag tora-auth-flow" data-entry={stage==='entry'} data-motion={motionSettings.effective} data-page-motion={motionSettings.pageEnabled} data-click-motion={motionSettings.clickEnabled} dir={i18n.language==='ar'?'rtl':undefined}>
  <button type="button" className="app-no-drag tora-auth-language" aria-label={t('settings.general.language.title')} onClick={()=>setLanguageOpen(true)}><Languages/><span>{t('settings.general.language.title')}</span></button>
  {stage!=='entry'&&stage!=='passkey'&&<button type="button" className="app-no-drag tora-auth-back" aria-label={copy('back')} disabled={busy} onClick={()=>move(stage==='email'||stage==='methods'?'entry':stage==='password'||stage==='signupPassword'?'email':stage==='challenge'?challengeMode==='password'?'password':intent==='signup'?'signupPassword':'password':stage==='resetPassword'?'code':'email')}><ArrowLeft/></button>}
  <motion.section className="app-no-drag tora-auth-form" initial={false} layout={motionSettings.effective!=='off'&&motionSettings.pageEnabled?'position':false} layoutDependency={stage} transition={{layout:{duration:motionSettings.effective==='fast'?.24:.38,ease:[.22,1,.36,1]}}}><fieldset key={stage} data-auth-step={stage} disabled={busy&&stage!=='passkey'} className="m-0 min-w-0 border-0 p-0">
   {stage==='entry'?<><img className="tora-auth-mark" src="/icon.png" alt="Tora" width={44} height={44}/><h1>{copy('loginTitle')}</h1><AuthAction loading={busy} label={busy?copy('working'):copy('continueLogin')} onClick={()=>{setIntent('login');setLoginMethod('password');move('email');}} disabled={busy}/><AuthAction secondary label={copy('otherMethods')} onClick={()=>move('methods')} disabled={busy}/><button type="button" className="tora-auth-link tora-auth-entry-register" onClick={()=>{setIntent('signup');move('email');}}>{copy('signUp')}</button>{notice&&<p role="status" className="tora-auth-notice">{notice}</p>}</>
   :stage==='methods'?<><h1>{copy('loginTitle')}</h1><AuthAction secondary label={copy('codeLogin')} onClick={()=>{setIntent('login');setLoginMethod('code');move('email');}} disabled={busy}/><AuthAction secondary label={copy('passkeyLogin')} onClick={()=>void startPasskeyLogin()} disabled={busy} icon={<KeyRound/>}/>{footer}</>
   :stage==='email'?<><h1>{copy(intent==='signup'?'signupTitle':'emailTitle')}</h1><p className="tora-auth-description">{copy('emailDescription')}</p><AuthField label={copy('email')} value={account} onChange={setAccount} autoComplete="username" autoCapitalize="off" autoCorrect="off" onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing)void lookup();}}/><AuthAction loading={busy} label={busy?copy('working'):copy('continue')} onClick={()=>void lookup()} disabled={busy||(!account.trim())}/><p className="tora-auth-switch">{copy(intent==='signup'?'haveAccount':'newAccount')} <button type="button" className="tora-auth-link" onClick={()=>setIntent(intent==='signup'?'login':'signup')}>{copy(intent==='signup'?'logIn':'signUp')}</button></p><div className="tora-auth-or">{copy('or')}</div><AuthAction secondary label={copy('passkeyLogin')} onClick={()=>void startPasskeyLogin()} disabled={busy} icon={<KeyRound/>}/>{footer}</>
   :stage==='password'||stage==='signupPassword'||stage==='resetPassword'?<><h1>{copy(stage==='password'?'passwordTitle':stage==='resetPassword'?'resetTitle':'createPasswordTitle')}</h1>{stage!=='password'&&<p className="tora-auth-description">{copy('passwordDescription')}</p>}{identity}<AuthField label={copy('password')} value={password} onChange={setPassword} password autoComplete={stage==='password'?'current-password':'new-password'} maxLength={128}/>{stage==='password'?<button type="button" className="tora-auth-link tora-auth-forgot" onClick={()=>requestChallenge('reset','email')}>{copy('forgotPassword')}</button>:<div className="tora-auth-password-rule" data-valid={password.length>=8}>{copy('minimumPassword',{count:8})}</div>}<AuthAction loading={busy} label={busy?copy('working'):copy('continue')} onClick={()=>stage==='resetPassword'?void resetPassword():requestChallenge(stage==='signupPassword'?'signup':'login',stage==='signupPassword'?'email':'password')} disabled={busy||(stage==='password'?!password:password.length<8)}/>{stage==='password'&&<><div className="tora-auth-or">{copy('or')}</div><AuthAction secondary label={copy('codeLogin')} onClick={()=>requestChallenge('login','email')} disabled={busy}/><AuthAction secondary label={copy('passkeyLogin')} onClick={()=>void startPasskeyLogin()} disabled={busy} icon={<KeyRound/>}/></>}{footer}</>
   :stage==='challenge'?<><h1>{copy('verifyIdentity')}</h1><p className="tora-auth-description">{copy('verifyDescription')}</p><Turnstile ref={turnstile} action={intent==='signup'?'register':'login'} onToken={setProof}/><AuthAction loading={busy} label={busy?copy('working'):copy('continue')} onClick={()=>void challenge()} disabled={busy||(!proof)}/>{footer}</>
   :stage==='code'?<><h1>{copy('codeTitle')}</h1><p className="tora-auth-description">{copy('codeDescription',{email:account})}</p><AuthField label={copy('code')} value={code} onChange={value=>setCode(value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} onKeyDown={event=>{if(event.key==='Enter'&&code.length===6&&!event.nativeEvent.isComposing)void verifyCode();}}/><AuthAction loading={busy} label={busy?copy('working'):copy('continue')} onClick={()=>void verifyCode()} disabled={busy||(code.length!==6)}/><button type="button" className="tora-auth-link tora-auth-resend" disabled={busy||cooldown>0} onClick={()=>requestChallenge(intent,'email')}>{cooldown>0?copy('resendIn',{seconds:cooldown}):copy('resend')}</button>{footer}</>
   :<><KeyRound className="tora-auth-passkey-mark"/><h1>{copy('passkeyTitle')}</h1><p className="tora-auth-description">{copy('passkeyDescription')}</p>{handoff&&<><output className="tora-auth-confirmation" dir="ltr">{handoff.confirmation}</output><a className="tora-auth-primary" href={handoff.url} target="_blank" rel="noopener noreferrer">{copy('openBrowser')}</a></>}{!error&&<p className="tora-auth-description" role="status">{copy('passkeyWaiting')}</p>}<button type="button" className="tora-auth-link" onClick={cancelPasskey}>{copy('cancel')}</button></>}
   {error&&<p className="tora-auth-error" role="alert">{error}</p>}
  </fieldset></motion.section>
  {languageOpen&&<Suspense fallback={null}><LanguageDialog onClose={()=>setLanguageOpen(false)}/></Suspense>}
 </main>;
}
