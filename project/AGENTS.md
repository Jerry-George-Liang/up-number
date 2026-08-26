# Active 43123 Scope

This directory is the only editable project in the current workspace. It is
served on port `43123` by `com.up-icloud.local`. Build, test, deploy, and restart
only this project.

Keep it independent from the sibling `../queue-management` project on port
`3001` and that project's nested helper on port `43124`. Do not modify, build,
restart, or deploy either sibling unless the user explicitly changes the
project scope again.
