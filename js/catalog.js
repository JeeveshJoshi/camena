/* catalog.js — the trend catalog and the label→tag vocabulary.
   This is pure data. TRENDS is hard-coded here in the SAME shape the real backend
   will serve (GitHub Actions → static catalog.json), so wiring up the live catalog
   later means swapping this array's source and nothing else. See CLAUDE.md.

   Per-trend edit fields:
     minShots      viability floor — below this the trend can't be built (advisor instead)
     maxShots      upper bound on cut count, whatever the supply
     targetSeconds the reel length we aim for; with bpm this decides how many cuts
     sound.bpm     tempo of the suggested sound. Nothing is baked into the export —
                   we only cut ON the beat grid, so when the user adds that sound
                   natively in Instagram the cuts land musically. */
"use strict";

/* Trend catalog — keyed on scene tags so real photos match. */
export const TRENDS = [
  {id:'beach', type:'location', chip:'Travel', title:'Golden-hour beaches', growth:180,
   minShots:5, maxShots:14, targetSeconds:14,
   keywords:['beach','ocean','sea','coast','sand','nature'],
   sound:{name:'Saiyaara · slowed', uses:'412k reels', bpm:90},
   capture:['Shoot 3–5 vertical clips: shoreline, the horizon, your feet in the sand','Hold each 2–3s with slow pans','Golden hour reads best']},
  {id:'food', type:'food', chip:'Food', title:'Plate-it-up food', growth:140,
   minShots:5, maxShots:12, targetSeconds:12,
   keywords:['food','plate','meal','dish','drink'],
   sound:{name:'Espresso · sped up', uses:'1.2M reels', bpm:124},
   capture:['Top-down shot of the plate, then a slow tilt up','The first bite is the money shot','Bright, even light — no flash']},
  {id:'coffee', type:'food', chip:'Food', title:'Coffee moments', growth:110,
   minShots:5, maxShots:12, targetSeconds:12,
   keywords:['coffee','cup','drink','espresso'],
   sound:{name:'Lover · acoustic', uses:'880k posts', bpm:96},
   capture:['Top-down of the pour, then tilt to the cup','Steam and the first sip carry it','Window light, no flash']},
  {id:'pets', type:'subject', chip:'Pets', title:'Pets of the week', growth:220,
   minShots:5, maxShots:13, targetSeconds:13,
   keywords:['pet','animal','dog','cat'],
   sound:{name:'Magnetic · clip', uses:'2.1M reels', bpm:128},
   capture:['Get down to their eye level','Catch a head tilt or a zoomie','Treats get their attention to camera']},
  {id:'mountain', type:'location', chip:'Travel', title:'Mountain & trail', growth:90,
   minShots:5, maxShots:14, targetSeconds:15,
   keywords:['mountain','nature','snow','hill','sky'],
   sound:{name:'Kesariya · instrumental', uses:'240k reels', bpm:84},
   capture:['Wide establishing shot, then a walking POV','Silhouettes against the sky pop','Steady, slow movement over fast cuts']},
  {id:'dump', type:'format', chip:'Format', title:'Photo-dump carousel', growth:70,
   minShots:6, maxShots:15, targetSeconds:15,
   keywords:[],
   sound:{name:'Lover · loop', uses:'1.5M posts', bpm:120},
   capture:['Pick 6–10 of your best recent shots','Mix wide scenes with a couple of close-ups','Keep it candid — no heavy filters']},
  {id:'dance', type:'dance', chip:'Dance', title:'Trending hook step', growth:260,
   minShots:6, maxShots:12, targetSeconds:15,
   keywords:['dance'],
   sound:{name:'Peelings · hook', uses:'2.4M reels', bpm:130},
   capture:['This one you perform — it can’t be built from old photos','Film face-on, full body, good light','Learn the 8-count, then 2–3 clean takes']}
];

/* ImageNet label → coarse tag mapping. MobileNet returns specific ImageNet class
   names (e.g. 'seashore', 'espresso'); each rule collapses a cluster of those into
   one of the coarse tags the trend catalog matches on. */
export const TAG_RULES = [
  {tag:'beach',   needles:['seashore','sandbar','promontory','cliff','coast','breakwater','lakeside','ocean','beach']},
  {tag:'ocean',   needles:['seashore','sandbar','ocean','reef','coral','catamaran','speedboat','lakeside','breakwater','sea','snorkel','scuba']},
  {tag:'sea',     needles:['seashore','sandbar','ocean','lakeside','breakwater']},
  {tag:'sand',    needles:['sandbar','seashore','desert']},
  {tag:'mountain',needles:['alp','volcano','valley','cliff','geyser','mountain']},
  {tag:'snow',    needles:['ski','snow','alp','glacier','snowmobile','dogsled','snowplow']},
  {tag:'hill',    needles:['valley','alp','volcano','cliff']},
  {tag:'nature',  needles:['valley','alp','lakeside','park bench','forest','meadow','hay','rapeseed','volcano','geyser','coral','daisy','butterfly','bee']},
  {tag:'sky',     needles:['balloon','airship','parachute','kite','alp','promontory']},
  {tag:'food',    needles:['plate','cheeseburger','pizza','hotdog','guacamole','burrito','ice cream','ice lolly','bagel','pretzel','meat loaf','consomme','hot pot','trifle','mashed potato','cauliflower','broccoli','cabbage','cucumber','bell pepper','mushroom','carbonara','dough','french loaf','spaghetti','soup','potpie','waffle','banana','pineapple','strawberry','orange','lemon','fig','pomegranate','corn','burrito']},
  {tag:'plate',   needles:['plate','dining table','tray']},
  {tag:'meal',    needles:['plate','cheeseburger','pizza','hotdog','carbonara','potpie','dining table']},
  {tag:'dish',    needles:['plate','consomme','hot pot','trifle','potpie','soup']},
  {tag:'coffee',  needles:['espresso','coffeepot','coffee mug','cup']},
  {tag:'cup',     needles:['cup','coffee mug','espresso','goblet']},
  {tag:'drink',   needles:['cup','espresso','red wine','wine','beer','cocktail','eggnog','water bottle','pop bottle','goblet','beer glass']},
  {tag:'pet',     needles:['retriever','terrier','poodle','spaniel','setter','collie','shepherd','pug','beagle','bulldog','chihuahua','dalmatian','husky','corgi','labrador','tabby','egyptian cat','persian cat','siamese','tiger cat','kitten','puppy','pomeranian','rottweiler','dachshund','schnauzer','mastiff']},
  {tag:'dog',     needles:['retriever','terrier','poodle','spaniel','setter','collie','shepherd','pug','beagle','bulldog','chihuahua','dalmatian','husky','corgi','labrador','pomeranian','rottweiler','dachshund']},
  {tag:'cat',     needles:['tabby','egyptian cat','persian cat','siamese','tiger cat','lynx']},
  {tag:'animal',  needles:['retriever','terrier','horse','elephant','lion','tiger','zebra','giraffe','bird','panda','bear','monkey','deer','fox','rabbit','squirrel','cow','ox','sheep','goat','peacock','flamingo','parrot','owl','penguin']},
  {tag:'city',    needles:['palace','monastery','castle','church','mosque','bell cote','suspension bridge','pier','dock','street sign','traffic light','obelisk','fountain','cinema','library','restaurant','bookshop','barbershop','tobacco shop']},
  {tag:'architecture',needles:['palace','monastery','castle','church','mosque','dome','obelisk','triumphal arch','stupa','column','bell cote']},
  {tag:'vehicle', needles:['sports car','minivan','jeep','pickup','motor scooter','mountain bike','convertible','cab','limousine','racer','moped','trailer truck','tow truck','school bus']},
  {tag:'people',  needles:['suit','bow tie','sunglass','maillot','bikini','jersey','groom','gown','wig','cowboy hat','sombrero','academic gown','military uniform','swimming trunks','brassiere','miniskirt']},
];

/* Labels that mark a frame as junk for reel purposes — screenshots, documents,
   receipts, menus. A real camera roll (especially a trip) is full of these and they
   poison an otherwise good edit. Only applied when the model is reasonably confident
   (see JUNK_MIN_PROB in matcher.js) to avoid false positives on legitimate photos. */
export const JUNK_RULES = [
  'web site','menu','crossword puzzle','scoreboard','digital clock','envelope',
  'book jacket','comic book','binder','packet','carton','rubber eraser','matchstick'
];
