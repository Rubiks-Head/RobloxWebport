Hi dumbass's, I'm making this for you guys to easily add auth off Roblox. 
- *(Note, I **REALLY** recommend using an alt account until it is proven that there is no chance your account can and will be flagged)*

Here are the steps, from making an account to adding your auth to the cnfg.json file.

- 1. Making a new account.
> To get started, go to https://www.roblox.com/CreateAccount and make an account normally.

- 2. Getting your auth.
> This is the hardest part; press `F12`, and when your DevTools pop up, press the `>>` symbol. 
> After you press that, press the `Application` Tab. On that tab, you should see a Cookies dropdown; press it.
> After you press that, it should open, and you should see a `https://www.roblox.com` option. Also press that.
> Once you press that too, you should see a table pop up, and you need to look for the value named `.ROBLOXSECURITYTOKEN` or a cookie that starts with `_|WARNING:-DO-NOT-SHARE-THIS...`.
> You are going to want to copy that entire security token.
^^ Here is an image that should be helpful <img width="807" height="788" alt="image" src="https://github.com/user-attachments/assets/630dca8b-5efa-4cb3-b608-adea3de643cd" />

- 3. Adding your auth.
> Find the cnfg.example.json and rename it to cnfg.json. Then find the value `robloxAuthToken` and add your cookie to it. 
> After you do that, ensure `autoInjectServerSideAuth` is set to `"true"`

And that's about it! Pretty easy, I know, cuz I made it... Anyways, good luck with wtvr
