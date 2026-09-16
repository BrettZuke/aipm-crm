// The email scripts, one source for the sender (api/send.js), the dashboard's
// Email report and the page's Scripts tab (served through api/library). Written
// agreed on 2026-09-15: problem, agitate, solution, and the solution is
// always the click. Fields: {{business}}, {{town}} (falls back to "your area"),
// {{link}} (the lead's tracked page), {{phone}} (their number; a sentence that
// needs it disappears when there is none), {{your_name}} and {{your_phone}}.
//
//   any      the first email, rotated across every lead by its row
//   nosite   first emails that only go to a business with no website
//   follow   the five follow-ups, days 3, 7, 12, 18, 25
//   nurture  every 30 days after that
export const EMAIL_SIGN = "\n\n{{your_name}}\n{{your_phone}}\n\nSent from my iPhone";

export const EMAILS = [
  {
    "key": "e01",
    "use": "any",
    "title": "Everyone 1: {business}",
    "situation": "First email. Rotated across every lead.",
    "subject": "{{business}}",
    "body": "hi, is this the right email for whoever runs {{business}}? every week people in {{town}} look for what you do, can't get hold of you fast enough, and book someone else. I stop that happening and it doesn't cost the earth. put it on a page for you {{link}}"
  },
  {
    "key": "e02",
    "use": "any",
    "title": "Everyone 2: the call you missed",
    "situation": "First email. Rotated across every lead.",
    "subject": "the call you missed",
    "body": "hey, you were on a job, the phone rang, you didn't get to it. that was a job. it's gone to whoever answered. I make sure {{business}} never loses one that way again. here's how {{link}}"
  },
  {
    "key": "e03",
    "use": "any",
    "title": "Everyone 3: the enquiry from tuesday",
    "situation": "First email. Rotated across every lead.",
    "subject": "the enquiry from tuesday",
    "body": "hi, someone messaged {{business}} this week and waited. by the time you got back to them they'd booked someone else. that's not a you problem, it's a setup problem. I fix the setup {{link}}"
  },
  {
    "key": "e04",
    "use": "any",
    "title": "Everyone 4: reviews",
    "situation": "First email. Rotated across every lead.",
    "subject": "reviews",
    "body": "hey, the business with the most recent google reviews in {{town}} gets the call, not the best one. if your last review is from months ago you're losing to worse tradesmen with newer reviews. I get a review off every customer for you, automatically {{link}}"
  },
  {
    "key": "e05",
    "use": "any",
    "title": "Everyone 5: second on google",
    "situation": "First email. Rotated across every lead.",
    "subject": "second on google",
    "body": "hi, being second on google in {{town}} is worth about nothing. nobody scrolls. I get {{business}} found first and answering first. it's on a page here {{link}}"
  },
  {
    "key": "e06",
    "use": "any",
    "title": "Everyone 6: quiet weeks",
    "situation": "First email. Rotated across every lead.",
    "subject": "quiet weeks",
    "body": "hey, flat out one month, dead the next. that's what happens when the work depends on who happens to ring. I put in a steady flow of enquiries for {{business}} so the quiet weeks stop. have a look {{link}}"
  },
  {
    "key": "e07",
    "use": "any",
    "title": "Everyone 7: the quotes you sent",
    "situation": "First email. Rotated across every lead.",
    "subject": "the quotes you sent",
    "body": "hi, you sent the quote, they went quiet, you moved on. half of those were still going to happen if someone had chased. I chase every quote for {{business}} automatically until it's a yes or a no {{link}}"
  },
  {
    "key": "e08",
    "use": "any",
    "title": "Everyone 8: word of mouth",
    "situation": "First email. Rotated across every lead.",
    "subject": "word of mouth",
    "body": "hey, word of mouth has done {{business}} proud. it also caps you at whatever your customers happen to say this month. I add the bit that brings the work in whether anyone's talking about you or not {{link}}"
  },
  {
    "key": "e09",
    "use": "any",
    "title": "Everyone 9: 9pm",
    "situation": "First email. Rotated across every lead.",
    "subject": "9pm",
    "body": "hi, a lot of people look for a business like yours at 9pm on their phone. nobody answers at 9pm, so they book whoever replies first in the morning, and it's not always you. I make it always you {{link}}"
  },
  {
    "key": "e10",
    "use": "any",
    "title": "Everyone 10: the second job",
    "situation": "First email. Rotated across every lead.",
    "subject": "the second job",
    "body": "hey, you did a good job and never heard from them again. not because they weren't happy, because nobody reminded them you exist. I keep {{business}} in front of every customer you've ever had {{link}}"
  },
  {
    "key": "e11",
    "use": "any",
    "title": "Everyone 11: referrals",
    "situation": "First email. Rotated across every lead.",
    "subject": "referrals",
    "body": "hi, your customers would happily send you their mates. they don't, because nobody asks and there's nothing in it for them. I set up a referral thing for {{business}} that asks every time and pays them for it {{link}}"
  },
  {
    "key": "e12",
    "use": "any",
    "title": "Everyone 12: admin at 10pm",
    "situation": "First email. Rotated across every lead.",
    "subject": "admin at 10pm",
    "body": "hey, quoting, chasing, replying to messages, all after a full day's work. that's the job on top of the job. I take that whole pile off {{business}} and it runs itself. here {{link}}"
  },
  {
    "key": "e13",
    "use": "any",
    "title": "Everyone 13: price shoppers",
    "situation": "First email. Rotated across every lead.",
    "subject": "price shoppers",
    "body": "hi, when nothing about {{business}} stands out online, people ring three of you and pick the cheapest. I make you the one they were already sold on before they rang. have a look {{link}}"
  },
  {
    "key": "e14",
    "use": "any",
    "title": "Everyone 14: worse than you, busier than you",
    "situation": "First email. Rotated across every lead.",
    "subject": "worse than you, busier than you",
    "body": "hey, there's someone in {{town}} who does a worse job than {{business}} and gets more work. that's not skill, it's setup. I fix the setup {{link}}"
  },
  {
    "key": "e15",
    "use": "any",
    "title": "Everyone 15: \"I'll get back to you\"",
    "situation": "First email. Rotated across every lead.",
    "subject": "\"I'll get back to you\"",
    "body": "hi, the enquiries you meant to get back to are the most expensive thing in your business. each one was a job. I make sure {{business}} gets back to every one in under a minute, even when you can't {{link}}"
  },
  {
    "key": "e16",
    "use": "any",
    "title": "Everyone 16: messages you never saw",
    "situation": "First email. Rotated across every lead.",
    "subject": "messages you never saw",
    "body": "hey, facebook messages, voicemails, a form on a site somewhere. enquiries for {{business}} are landing in five places and some never get seen. I put them all in one place and chase every one {{link}}"
  },
  {
    "key": "e17",
    "use": "any",
    "title": "Everyone 17: keeping vs finding",
    "situation": "First email. Rotated across every lead.",
    "subject": "keeping vs finding",
    "body": "hi, finding a new customer costs {{business}} time and money. keeping one costs nothing, and most businesses in {{town}} don't even try. I do the keeping for you, automatically {{link}}"
  },
  {
    "key": "e18",
    "use": "any",
    "title": "Everyone 18: your best month",
    "situation": "First email. Rotated across every lead.",
    "subject": "your best month",
    "body": "hey, whatever made your best month at {{business}}, it was luck as much as anything. I make it the normal month. this is how {{link}}"
  },
  {
    "key": "e19",
    "use": "any",
    "title": "Everyone 19: the number you don't know",
    "situation": "First email. Rotated across every lead.",
    "subject": "the number you don't know",
    "body": "hi, genuine question, how many enquiries did {{business}} get last month and how many turned into jobs? if you don't know, that's where the money's leaking. I show you, then I plug it {{link}}"
  },
  {
    "key": "e20",
    "use": "any",
    "title": "Everyone 20: can't do both",
    "situation": "First email. Rotated across every lead.",
    "subject": "can't do both",
    "body": "hey, you can't be up a ladder and on the phone. so the phone loses, and the phone is where the money is. I answer for {{business}} while you work {{link}}"
  },
  {
    "key": "e21",
    "use": "any",
    "title": "Everyone 21: one bad review",
    "situation": "First email. Rotated across every lead.",
    "subject": "one bad review",
    "body": "hi, one bad review from two years ago is sitting above the fold when people in {{town}} look at {{business}}. it stays there until newer ones bury it. I get you the newer ones, every job {{link}}"
  },
  {
    "key": "e22",
    "use": "any",
    "title": "Everyone 22: they check you on their phone first",
    "situation": "First email. Rotated across every lead.",
    "subject": "they check you on their phone first",
    "body": "hey, before anyone rings {{business}} they look you up on their phone. what they find decides whether they ring. I make what they find do the selling {{link}}"
  },
  {
    "key": "e23",
    "use": "any",
    "title": "Everyone 23: the first five minutes",
    "situation": "First email. Rotated across every lead.",
    "subject": "the first five minutes",
    "body": "hi, an enquiry answered in five minutes books. the same enquiry answered in an hour has already booked someone else. I get {{business}} to five minutes, every time, without you doing it {{link}}"
  },
  {
    "key": "e24",
    "use": "any",
    "title": "Everyone 24: last year's customers",
    "situation": "First email. Rotated across every lead.",
    "subject": "last year's customers",
    "body": "hey, everyone {{business}} worked for last year needs something again this year. they've forgotten your name. I remind them, so the repeat work comes back without you chasing it {{link}}"
  },
  {
    "key": "e25",
    "use": "any",
    "title": "Everyone 25: people ask AI now",
    "situation": "First email. Rotated across every lead.",
    "subject": "people ask AI now",
    "body": "hi, people in {{town}} are asking google and chatgpt who to call instead of scrolling a list. if {{business}} isn't set up for that, you're not in the answer. I set it up {{link}}"
  },
  {
    "key": "e26",
    "use": "any",
    "title": "Everyone 26: more jobs, same hours",
    "situation": "First email. Rotated across every lead.",
    "subject": "more jobs, same hours",
    "body": "hey, the only way to earn more right now is to work more hours. I change that for {{business}}. more jobs from the same hours, because the finding and chasing stops being your job {{link}}"
  },
  {
    "key": "e27",
    "use": "any",
    "title": "Everyone 27: paying for leads you don't own",
    "situation": "First email. Rotated across every lead.",
    "subject": "paying for leads you don't own",
    "body": "hi, if you're paying for leads from a site that sells the same lead to four other businesses, you're renting your customers. I build {{business}} its own flow of them that nobody else gets. here {{link}}"
  },
  {
    "key": "e28",
    "use": "any",
    "title": "Everyone 28: short one",
    "situation": "First email. Rotated across every lead.",
    "subject": "short one",
    "body": "hey, keeping this short. I get businesses in {{town}} more jobs and I reckon I can do it for {{business}}. easier to show than explain, it's here {{link}}. if not, no bother"
  },
  {
    "key": "n01",
    "use": "nosite",
    "title": "No website 1: couldn't find you",
    "situation": "First email, only to a business with no website.",
    "subject": "couldn't find you",
    "body": "hi, went looking for {{business}} like a customer in {{town}} would and couldn't find you anywhere. every one of those people rang someone else. that's the first thing I'd fix, and then the rest {{link}}"
  },
  {
    "key": "n02",
    "use": "nosite",
    "title": "No website 2: going next door",
    "situation": "First email, only to a business with no website.",
    "subject": "going next door",
    "body": "hey, the businesses in {{town}} people can actually find online are getting the jobs that should be yours. not better, just findable. I make {{business}} findable and then keep the customers it brings {{link}}"
  },
  {
    "key": "n03",
    "use": "nosite",
    "title": "No website 3: until it isn't",
    "situation": "First email, only to a business with no website.",
    "subject": "until it isn't",
    "body": "hi, word of mouth is great until you have a quiet month and there's nothing behind it. I give {{business}} something behind it, a steady flow of people in {{town}} finding you and getting answered {{link}}"
  },
  {
    "key": "n04",
    "use": "nosite",
    "title": "No website 4: outside facebook",
    "situation": "First email, only to a business with no website.",
    "subject": "outside facebook",
    "body": "hey, people who already follow {{business}} on facebook can find you. the ones who don't, can't, and there's a lot more of them. I fix that and I make sure they get answered when they come {{link}}"
  },
  {
    "key": "n05",
    "use": "nosite",
    "title": "No website 5: google shows the others",
    "situation": "First email, only to a business with no website.",
    "subject": "google shows the others",
    "body": "hi, type what you do and {{town}} into google. it shows your competitors, not {{business}}. every day that's jobs. I get you on that list and answering faster than them {{link}}"
  },
  {
    "key": "n06",
    "use": "nosite",
    "title": "No website 6: the one that gave up",
    "situation": "First email, only to a business with no website.",
    "subject": "the one that gave up",
    "body": "hey, someone tried to find {{business}} this week, couldn't, and gave up. you'll never know who. I make sure the next one finds you and gets a reply in a minute {{link}}"
  },
  {
    "key": "f1",
    "use": "follow",
    "title": "Follow-up 1: that page",
    "situation": "No reply after 3 days.",
    "subject": "that page",
    "body": "hey, in case it got buried. the page for {{business}} is here {{link}}. one minute. is {{phone}} still the best number for you?"
  },
  {
    "key": "f2",
    "use": "follow",
    "title": "Follow-up 2: the bit that pays for it",
    "situation": "Day 7.",
    "subject": "the bit that pays for it",
    "body": "hi, one thing I didn't mention. every enquiry gets answered in seconds and chased till it books. one job pays for the whole thing. it's on the page {{link}}"
  },
  {
    "key": "f3",
    "use": "follow",
    "title": "Follow-up 3: should I leave it?",
    "situation": "Day 12.",
    "subject": "should I leave it?",
    "body": "hey, last push from me. if it's bad timing just say not now and I'll check back in a few months. if you want a look at what I'd do for {{business}} it's here {{link}}"
  },
  {
    "key": "f4",
    "use": "follow",
    "title": "Follow-up 4: easier on the phone?",
    "situation": "Day 18.",
    "subject": "easier on the phone?",
    "body": "hi, tried you on email a couple of times, no worries. happy to talk you through it in two minutes on the phone if that's easier. I've got {{phone}} for you. or it's here {{link}}"
  },
  {
    "key": "f5",
    "use": "follow",
    "title": "Follow-up 5: closing this",
    "situation": "Day 25, the last one.",
    "subject": "closing this",
    "body": "hey, I'll assume it's not for you. the page stays up a bit longer if you ever want it {{link}}. good luck with the business"
  },
  {
    "key": "m1",
    "use": "nurture",
    "title": "Monthly: still here",
    "situation": "Every 30 days after the last follow-up, until they say stop.",
    "subject": "still here",
    "body": "hi, checking in like I said I would. if {{business}} has had a quiet spell since, the page still stands and so does the offer {{link}}. no bother either way"
  }
];

/* The cold-email pack from 10 September, approved again on 15 September: 26
   more first emails. Most join the everyone rotation; three only go where they
   are true: hassite, facebook (a page and no site), dated (an old or broken site). */
export const PACK = [
  {
    "key": "p01",
    "use": "any",
    "title": "Pack 1: {{business}}",
    "situation": "First email. Rotated across every lead.",
    "subject": "{{business}}",
    "body": "Hi,\n\nI put something together for {{business}} over in {{town}} and I would rather show you than try to explain it in an email.\n\n{{link}}\n\nTwo minutes. There is a button under it if you want to grab a time with me. Is {{phone}} still the best number for you?"
  },
  {
    "key": "p02",
    "use": "any",
    "title": "Pack 2: the jobs you never hear about",
    "situation": "First email. Rotated across every lead.",
    "subject": "the jobs you never hear about",
    "body": "Hi,\n\nThe ones that cost you are not the jobs you lose. They are the ones you never hear about: somebody in {{town}} looked for {{trades}} at nine at night, could not find you or could not be bothered waiting, and rang the next name down.\n\nHere is what I would put in place for {{business}} so that stops happening:\n\n{{link}}\n\nBooking link is under it. I have {{phone}} down for you, shout if that has changed."
  },
  {
    "key": "p03",
    "use": "any",
    "title": "Pack 3: quick one about {{business}}",
    "situation": "First email. Rotated across every lead.",
    "subject": "quick one about {{business}}",
    "body": "Hi,\n\nWhen somebody in {{town}} goes looking for {{trades}} they get a list, and most of the decision is made before anybody picks up a phone.\n\nI put together what {{business}} could look like at that moment, and what happens to an enquiry once it comes in:\n\n{{link}}\n\nHave a look, and if it is worth ten minutes the booking link is under it. If it is easier to talk than type, I have you on {{phone}}."
  },
  {
    "key": "p04",
    "use": "any",
    "title": "Pack 4: not a website",
    "situation": "First email. Rotated across every lead.",
    "subject": "not a website",
    "body": "Hi,\n\nI do not sell websites. A website on its own just sits there.\n\nWhat I put in is the thing around it: you get found, every enquiry gets answered in seconds whether you are free or not, none of them go missing, and your past customers keep sending you more.\n\nHere is what that looks like for {{business}}:\n\n{{link}}\n\nNo hard feelings if it is not for you, just say and I will leave you alone. Or I can ring you on {{phone}} if you would rather."
  },
  {
    "key": "p05",
    "use": "any",
    "title": "Pack 5: no idea if this is useful",
    "situation": "First email. Rotated across every lead.",
    "subject": "no idea if this is useful",
    "body": "Hi,\n\nNo idea if this is useful to you, but I put it together anyway.\n\n{{link}}\n\nIt is {{business}}, set up the way I would set it up for somebody working in {{town}}. If you like it there is a button underneath to book a call. If not, ignore me entirely. I have {{phone}} for you, tell me if that is the wrong one."
  },
  {
    "key": "p06",
    "use": "any",
    "title": "Pack 6: the missed call thing",
    "situation": "First email. Rotated across every lead.",
    "subject": "the missed call thing",
    "body": "Hi,\n\nThe job usually goes to whoever answers first, not whoever is best. Which is a hard one when you are already up a ladder.\n\nSo the answering does not wait for you. Every enquiry gets a reply in seconds and lands on your phone with their number on it. Two minutes on how that works for {{trades}} around {{town}}:\n\n{{link}}\n\nIf it is easier to ring, I have {{phone}} down."
  },
  {
    "key": "p07",
    "use": "any",
    "title": "Pack 7: the little map on google",
    "situation": "First email. Rotated across every lead.",
    "subject": "the little map on google",
    "body": "Hi,\n\nMost work for {{trades}} in {{town}} now comes off the little map that shows up first on Google. Three businesses get shown. Everyone else is a tap away, which in practice means never.\n\nGetting {{business}} into those three is mostly structure, and it is more fixable than people think. Two minutes on it here:\n\n{{link}}\n\nI have {{phone}} for you if a call is quicker."
  },
  {
    "key": "p08",
    "use": "any",
    "title": "Pack 8: people are asking AI for {{trades}} now",
    "situation": "First email. Rotated across every lead.",
    "subject": "people are asking AI for {{trades}} now",
    "body": "Hi,\n\nA lot of people looking for {{trades}} in {{town}} now ask an AI assistant instead of scrolling Google. It gives them two or three names and they ring one.\n\nWhether {{business}} is one of those names comes down to how everything is put together behind the scenes, and almost nobody local is set up for it yet. Short window.\n\nTwo minutes on it: {{link}}\n\nIf a call suits better I will try {{phone}}."
  },
  {
    "key": "p09",
    "use": "any",
    "title": "Pack 9: the reviews you are not getting",
    "situation": "First email. Rotated across every lead.",
    "subject": "the reviews you are not getting",
    "body": "Hi,\n\nYou have almost certainly done good work for people around {{town}} who would happily leave {{business}} a review. Almost none of them will, because nobody asked at the right moment.\n\nSo the asking stops being your job. Every finished customer gets asked automatically, and the good ones get pointed at Google:\n\n{{link}}\n\nIs {{phone}} still the best number for you?"
  },
  {
    "key": "p10",
    "use": "any",
    "title": "Pack 10: cold email, sorry",
    "situation": "First email. Rotated across every lead.",
    "subject": "cold email, sorry",
    "body": "Hi,\n\nThis is a cold email so I will be quick about it.\n\nI put systems into {{trades}} around {{town}} that bring them work every month rather than once. I put together what that looks like for {{business}}:\n\n{{link}}\n\nIf it is not for you, ignore it and I will not chase. If it is, the booking link is under it. I have {{phone}} down for you, shout if that has changed."
  },
  {
    "key": "p11",
    "use": "hassite",
    "title": "Pack 11: who looks after your website",
    "situation": "First email, only to a business that has a website.",
    "subject": "who looks after your website",
    "body": "Hi,\n\nWho looks after the website for {{business}} at the moment?\n\nAsking because a site is only the front of it. The part that makes the difference is what happens after somebody lands on it, and that is usually where there is nothing at all.\n\nEasier to show you than describe:\n\n{{link}}\n\nIf it is easier to talk than type, I have you on {{phone}}."
  },
  {
    "key": "p12",
    "use": "facebook",
    "title": "Pack 12: a website, not just the facebook page",
    "situation": "First email, only to a business with a Facebook page and no website.",
    "subject": "a website, not just the facebook page",
    "body": "Hi,\n\nFacebook is doing a lot of heavy lifting for {{business}} at the moment.\n\nThe trouble is people in {{town}} who are ready to spend tend to look for a proper website, and when there is not one they go back to the list. And a Facebook page cannot answer an enquiry at eleven at night.\n\nSo I put this together for you:\n\n{{link}}\n\nIf it is easier to talk than type, I have you on {{phone}}."
  },
  {
    "key": "p13",
    "use": "any",
    "title": "Pack 13: worth two minutes?",
    "situation": "First email. Rotated across every lead.",
    "subject": "worth two minutes?",
    "body": "Hi,\n\nQuick one. I recorded a couple of minutes on what I would change about how {{business}} gets work around {{town}}. Not the look of it, the machinery behind it.\n\n{{link}}\n\nIf it is nonsense, tell me and I will leave it there. If not, grab a slot from the link underneath. Or I can ring you on {{phone}} if you would rather."
  },
  {
    "key": "p14",
    "use": "any",
    "title": "Pack 14: for {{business}}",
    "situation": "First email. Rotated across every lead.",
    "subject": "for {{business}}",
    "body": "Hi,\n\nPut this together for you: {{link}}\n\nTwo minutes, booking link underneath. Built for somebody working in {{town}}. I have {{phone}} for you, tell me if that is the wrong one."
  },
  {
    "key": "p15",
    "use": "any",
    "title": "Pack 15: the other {{trade}} in {{town}}",
    "situation": "First email. Rotated across every lead.",
    "subject": "the other {{trade}} in {{town}}",
    "body": "Hi,\n\nWhen somebody is choosing between you and the other {{trades}} in {{town}}, they are reading reviews and ringing whoever answers. That whole decision happens before anybody speaks to anybody.\n\nBoth of those are fixable, and neither is really about the website. Here is what I would do for {{business}}:\n\n{{link}}\n\nIf it is easier to ring, I have {{phone}} down."
  },
  {
    "key": "p16",
    "use": "any",
    "title": "Pack 16: every month, not once",
    "situation": "First email. Rotated across every lead.",
    "subject": "every month, not once",
    "body": "Hi,\n\nMost people who sell to {{trades}} sell you a thing once and disappear. A site, some ads, a logo.\n\nI would rather put something in that keeps bringing {{business}} work every month and then be judged on whether it does. Two minutes on what that is:\n\n{{link}}\n\nI have {{phone}} for you if a call is quicker."
  },
  {
    "key": "p17",
    "use": "any",
    "title": "Pack 17: quick question",
    "situation": "First email. Rotated across every lead.",
    "subject": "quick question",
    "body": "Hi,\n\nAre you taking on new work in {{town}} at the moment?\n\nAsking because I built {{business}} something on the assumption that you are, and there is no point showing you if you are already flat out:\n\n{{link}}\n\nBooking link is under it if you want to talk. If a call suits better I will try {{phone}}."
  },
  {
    "key": "p18",
    "use": "any",
    "title": "Pack 18: am I talking to the right person",
    "situation": "First email. Rotated across every lead.",
    "subject": "am I talking to the right person",
    "body": "Hi,\n\nIf you are not the person who deals with how {{business}} in {{town}} gets its work in, could you point me at whoever is?\n\nAnd if it is you, this is the thing I wanted to show them:\n\n{{link}}\n\nTwo minutes, button under it to book a call. Is {{phone}} still the best number for you?"
  },
  {
    "key": "p19",
    "use": "any",
    "title": "Pack 19: {{town}}",
    "situation": "First email. Rotated across every lead.",
    "subject": "{{town}}",
    "body": "Hi,\n\nMost {{trades}} in {{town}} are invisible unless somebody already knows their name. Word of mouth still works, it just does not scale, and it stops the day the phone stops.\n\nI put two minutes together on the other half of it, built around {{business}}:\n\n{{link}}\n\nI have {{phone}} down for you, shout if that has changed."
  },
  {
    "key": "p20",
    "use": "any",
    "title": "Pack 20: before I forget",
    "situation": "First email. Rotated across every lead.",
    "subject": "before I forget",
    "body": "Hi,\n\nMeant to send this over earlier and it slipped.\n\n{{link}}\n\nIt is {{business}}, set up the way I think it should be for somebody trading in {{town}}. Have a look when you get five minutes, booking link is under it. If it is easier to talk than type, I have you on {{phone}}."
  },
  {
    "key": "p21",
    "use": "dated",
    "title": "Pack 21: have a look on your phone",
    "situation": "First email, only to a business whose website is dated or broken.",
    "subject": "have a look on your phone",
    "body": "Hi,\n\nMost people who look up {{trades}} in {{town}} are doing it on a phone, usually standing in the room with the problem.\n\n{{business}} is a little behind on one, so I rebuilt it, and wired up what happens after somebody taps call:\n\n{{link}}\n\nWorth a look on yours. Or I can ring you on {{phone}} if you would rather."
  },
  {
    "key": "p22",
    "use": "any",
    "title": "Pack 22: on a phone",
    "situation": "First email. Rotated across every lead.",
    "subject": "on a phone",
    "body": "Hi,\n\nMost people who look up {{trades}} in {{town}} are doing it on a phone, standing in the room with the problem. Whoever is easiest to act on in that moment gets the job, and that is usually decided in about five seconds.\n\nHere is {{business}} built around that:\n\n{{link}}\n\nWorth a look on yours. Or I can ring you on {{phone}} if you would rather."
  },
  {
    "key": "p23",
    "use": "any",
    "title": "Pack 23: you versus the top result",
    "situation": "First email. Rotated across every lead.",
    "subject": "you versus the top result",
    "body": "Hi,\n\nI had a look at what comes up for {{trades}} in {{town}}. The ones at the top are not doing better work than you. They are just easier to find and easier to trust in the five seconds somebody spends deciding.\n\nHere is {{business}} set up the same way:\n\n{{link}}\n\nTen minutes and I will show you the difference. I have {{phone}} for you, tell me if that is the wrong one."
  },
  {
    "key": "p24",
    "use": "any",
    "title": "Pack 24: what happens after they enquire",
    "situation": "First email. Rotated across every lead.",
    "subject": "what happens after they enquire",
    "body": "Hi,\n\nMost local businesses in {{town}} have somewhere for people to enquire and nothing at all behind it. The message lands in an inbox, gets seen four hours later, and by then they have booked somebody else.\n\nThat gap is the cheapest money in your business. Here is how I close it for {{business}}:\n\n{{link}}\n\nIf it is easier to ring, I have {{phone}} down."
  },
  {
    "key": "p25",
    "use": "any",
    "title": "Pack 25: did this for another {{trade}} not far from you",
    "situation": "First email. Rotated across every lead.",
    "subject": "did this for another {{trade}} not far from you",
    "body": "Hi,\n\nDid this for another {{trade}} recently and thought of {{business}}.\n\n{{link}}\n\nTwo minutes. Button under it if you want the same for {{town}}. I have {{phone}} for you if a call is quicker."
  },
  {
    "key": "p26",
    "use": "any",
    "title": "Pack 26: your past customers",
    "situation": "First email. Rotated across every lead.",
    "subject": "your past customers",
    "body": "Hi,\n\nThe cheapest work {{business}} will ever get is from people who already paid you once. Almost nobody in {{town}} does anything with that list, because there is never time.\n\nSo it runs on its own: they get asked for a review, and they get asked to send you somebody. Two minutes on it:\n\n{{link}}\n\nIf a call suits better I will try {{phone}}."
  }
];
PACK.forEach((e) => EMAILS.push(e));

export const emailsOf = (use) => EMAILS.filter((e) => e.use === use);
