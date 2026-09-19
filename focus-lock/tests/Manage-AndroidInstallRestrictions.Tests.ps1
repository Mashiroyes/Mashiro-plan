$ErrorActionPreference = 'Stop'
$env:ANDROID_RESTRICTIONS_TEST_MODE = '1'
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'Manage-AndroidInstallRestrictions.ps1'
. $scriptPath

Describe 'Manage-AndroidInstallRestrictions policy' {
    It 'preserves exactly the approved stores' {
        $policy = Get-RestrictionPolicy
        ($policy.PreservedStores -join ',') | Should Be 'com.android.vending,com.apkpure.aegon,cm.aptoide.pt'
    }

    It 'restricts exactly the approved stores' {
        $policy = Get-RestrictionPolicy
        ($policy.RestrictedStores -join ',') | Should Be 'com.xiaomi.market,com.coolapk.market,com.xiaomi.gamecenter'
    }

    It 'contains all approved browsers' {
        $policy = Get-RestrictionPolicy
        ($policy.Browsers -join ',') | Should Be 'com.android.browser,com.android.chrome,com.mmbox.xbrowser.pro,com.fooview.android.fooview,com.dv.adm'
    }

    It 'never includes QQ in a mutable list' {
        $policy = Get-RestrictionPolicy
        (($policy.RestrictedStores + $policy.Browsers) -contains 'com.tencent.mobileqq') | Should Be $false
    }
}

Describe 'ADB output parsing' {
    It 'parses one authorized device' {
        $devices = @(ConvertFrom-AdbDevicesOutput @(
            'List of devices attached',
            '4bafe2c                device product:marble model:23049RAD8C device:marble transport_id:2'
        ))
        $devices.Count | Should Be 1
        $devices[0].Serial | Should Be '4bafe2c'
        $devices[0].State | Should Be 'device'
    }

    It 'retains offline devices so validation cannot ignore them' {
        $devices = @(ConvertFrom-AdbDevicesOutput @(
            'List of devices attached',
            '4bafe2c offline transport_id:1'
        ))
        $devices[0].State | Should Be 'offline'
    }

    It 'parses every Android user including inactive spaces' {
        $users = @(ConvertFrom-AndroidUsersOutput @(
            'Users:',
            '    UserInfo{0:机主:4c13} running',
            '    UserInfo{11:security space:413}',
            '    UserInfo{999:XSpace:801010} running'
        ))
        ($users -join ',') | Should Be '0,11,999'
    }
}

Describe 'Package and AppOp parsing' {
    It 'parses an enabled installed package' {
        $state = ConvertFrom-PackageUserState -UserId 0 -Lines @(
            'User 0: ceDataInode=1 installed=true hidden=false suspended=false stopped=false enabled=0 instant=false'
        )
        $state.Installed | Should Be $true
        $state.Disabled | Should Be $false
        $state.Suspended | Should Be $false
    }

    It 'parses a disabled and suspended package' {
        $state = ConvertFrom-PackageUserState -UserId 11 -Lines @(
            'User 11: ceDataInode=1 installed=true hidden=false suspended=true stopped=true enabled=3 instant=false'
        )
        $state.Installed | Should Be $true
        $state.Disabled | Should Be $true
        $state.Suspended | Should Be $true
    }

    It 'parses an uninstalled package for a user' {
        $state = ConvertFrom-PackageUserState -UserId 0 -Lines @(
            'User 0: ceDataInode=0 installed=false hidden=false suspended=false stopped=true enabled=0 instant=false'
        )
        $state.Installed | Should Be $false
    }

    It 'parses explicit and default AppOp modes' {
        (ConvertFrom-AppOpOutput @('REQUEST_INSTALL_PACKAGES: deny')) | Should Be 'deny'
        (ConvertFrom-AppOpOutput @('No operations. Default mode: default')) | Should Be 'default'
    }
}

Describe 'Restoration state persistence' {
    It 'stores one unique record and removes it after restoration' {
        $directory = Join-Path $env:TEMP ('CodexAndroidRestrictions-' + [guid]::NewGuid().ToString('N'))
        $path = Join-Path $directory 'state.json'
        try {
            $state = Read-RestrictionState -Path $path
            $record = [pscustomobject]@{
                Kind = 'Browser'; UserId = 0; Package = 'com.android.chrome'; AppOp = 'default'
            }
            Add-StateRecord -State $state -Record $record -Path $path
            Add-StateRecord -State $state -Record $record -Path $path
            $loaded = Read-RestrictionState -Path $path
            @($loaded.Records).Count | Should Be 1

            Remove-StateRecord -State $loaded -Record $loaded.Records[0] -Path $path
            $empty = Read-RestrictionState -Path $path
            @($empty.Records).Count | Should Be 0
        }
        finally {
            if (Test-Path -LiteralPath $directory) {
                Remove-Item -LiteralPath $directory -Recurse -Force
            }
        }
    }
}

Remove-Item Env:ANDROID_RESTRICTIONS_TEST_MODE -ErrorAction SilentlyContinue
